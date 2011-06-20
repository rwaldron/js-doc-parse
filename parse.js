var tokenizer = require('uglify-js').parser.tokenizer,
	arrayToHash = require('uglify-js').parser.array_to_hash,
	fs = require('fs');

// PARSER:
// 1. build tree
// 2. hoist variable declarations within each function block
// 3. build symbol map for each block
//
// DOC BUILDER:
// 1. handle mixin to modules
// 2. handle dojo.declare of modules
// 3. handle return objects or functions as module
// 4. handle assignment onto modules from within other modules

function parse(data) {
	/**
	 * Creates a new Error with extra information on the position of the tokenizer at the time of failure.
	 */
	function error(/** ...string */) {
		var e = new Error([].slice.call(arguments, 0).join(' ') + ' at ' + (T.curr.line + 1) + ':' + (T.curr.col + 1));
		e.token = T.curr;
		return e;
	}

	/**
	 * Creates a tokenizer based on an array of tokens.
	 */
	function tokenizerFromArray(array) {
		return function () {
			return array.shift();
		};
	}

	/**
	 * Creates a new token stream. The first argument should be a function that returns the next token when it is
	 * called.
	 */
	function createTokenStream(getRawToken) {
		var prevToken,
			currToken,
			nextToken,
			isInForHeader = false,
			parenthesisLevel = 0;

		/**
		 * Tests whether a token matches the specified type and (optional) value.
		 */
		function tokenIs(type, value) {
			return this.type === type &&
				(value == null || (typeof value === 'object' ? value[this.value] : this.value === value));
		}

		/**
		 * Gets the next token from the tokenizer and decorates it with the tokenIs function.
		 */
		function getToken() {
			var token = getRawToken();
			token.is = tokenIs;

			currToken && (currToken.comments_after = token.comments_before);

			// 'prev' token = prevToken
			// 'curr' token = currToken
			// 'next' token = token

			// Probably incorrect automatic semicolon insertion
			// TODO: Try to fix this, or remove it completely if ASI is superfluous

			// ASI Rules:
			// Insert a semicolon before the next token that is not allowed by the ES5 grammar
			// if the offending token is separated from the previous token by a line break, or
			// if the offending token is },
			// as long as
			// it is not in the header of a FOR statement, and
			// the new semicolon will not be considered an empty statement
			// furthermore, insert a semicolon if
			// if there is a line break before a postfix operator, or
			// there is a line break after a 'continue', 'break', 'return', or 'throw' keyword

			// All the shit below this point is just to try to *approximate* ASI; it’s not even totally correct
			// since it absolutely does not check against all possible valid grammars before inserting
			// semicolons

			// A bunch of otherwise useless logic to ensure if we are inside a 'for' header, ASI is forbidden
			if (token.is('keyword', 'for')) {
				isInForHeader = true;
			}
			else if (isInForHeader && token.is('punc', '(')) {
				++parenthesisLevel;
			}
			else if (token.is('punc', ')') && (--parenthesisLevel) === 0) {
				isInForHeader = false;
			}

			if (!token.nlb && !token.is('punc', '}')) { // the next token is not separated from the previous token
				return token;                           // by a line break, nor is it }
			}

			if (currToken.is('punc', ';') || token.is('punc', ';')) { // a semicolon would be considered an empty
				return token;                                         // statement
			}

			if (isInForHeader) { // we are in the header of a FOR statement
				return token;
			}

			if (token.nlb && (                           // next token is after a line break, and
			    token.is('operator', '++') ||            // next token is a postfix operator or
				currToken.is('keyword', ASI_KEYWORDS)    // current token is one of the magic keywords where new lines
				) &&                                     // are prohibited, and
				!currToken.is('operator') &&             // neither the last token nor the next token are operators or
				!currToken.is('punc', ARGS_OR_ACCESSORS) && // accessors or an argument list (this part is not actually
				!token.is('operator') &&                 // written explicitly in the spec, I’m just winging it because
				!currToken.is('punc', ARGS_OR_ACCESSORS) // I don’t know how the fuck to do “not allowed by the grammar”
			) {
				nextToken = token;
				token = {
					type: 'punc',
					value: ';',
					line: token.line,
					col: token.col,
					pos: 'asi',
					nlb: false,
					is: tokenIs
				};
			}

			// TODO: Impossible-to-hand-code invalid grammar bullshit goes here

			return token;
		}

		return {
			/**
			 * Gets the previous token without rewinding the tokenizer.
			 */
			get prev() {
				return prevToken;
			},

			/**
			 * Gets the next token without forwarding the tokenizer.
			 */
			get peek() {
				return nextToken || (nextToken = getToken());
			},

			/**
			 * Gets the current token.
			 */
			get curr() {
				return currToken || T.next();
			},

			/**
			 * Forwards the tokenizer and returns the next token.
			 */
			next: function () {
				prevToken = currToken;

				if (nextToken) {
					currToken = nextToken;
					nextToken = undefined;
				}
				else {
					currToken = getToken();
				}

				return currToken;
			},

			/**
			 * Checks that the current token matches the given type and optional value, and throws an error
			 * if it does not.
			 */
			expect: function (type, value) {
				if (!T.curr.is(type, value)) {
					throw error('Expected', type, value, 'got', T.curr.type, T.curr.value);
				}
			},

			/**
			 * Fast forwards through the list of tokens until a token matching the given type and optional
			 * value is discovered. Leaves the tokenizer pointing at the first token after the matched token.
			 * Returns an array of tokens that were forwarded through, excluding the initial token and the
			 * matched token.
			 */
			nextUntil: function (type, value, endAtMatchedToken) {
				var tokens = [];

				while (this.next() && !this.curr.is(type, value)) {
					if (this.curr.is('eof')) {
						throw new Error('Unexpected end of file at ' + (this.curr.line + 1) + ':' + (this.curr.col + 1));
					}

					if (this.curr.is('punc', '{')) {
						tokens.push(this.nextUntil('punc', '}', true));
					}
					else if (this.curr.is('punc', '[')) {
						tokens.push(this.nextUntil('punc', ']', true));
					}
					else if (this.curr.is('punc', '(')) {
						tokens.push(this.nextUntil('punc', ')', true));
					}
					else {
						tokens.push(this.curr);
					}
				}

				!endAtMatchedToken && this.next(); // skip closing token

				return tokens;
			}
		}
	}

	// These operators can be prefixed to an otherwise unremarkable function definition to turn it into a function
	// expression that can be immediately invoked
	var OPERATORS_RTL = arrayToHash([ '!', '~', '+', '-', 'typeof', 'void', 'delete' ]),

		// Skip all of these types of blocks since they involve conditionals that we do not want to pay attention to
		// TODO: More robust support for loops/conditionals, especially for has()?
		KEYWORDS_TO_SKIP = arrayToHash([ 'catch', 'do', 'else', 'for', 'if', 'switch', 'while', 'with' ]),

		// ASI is the WORST FUCKING THING in the world and I hate anyone that thought it was a good idea to put it in
		// the spec, it makes parsing WAY TOO FUCKING DIFFICULT
		ASI_KEYWORDS = arrayToHash([ 'continue', 'break', 'return', 'throw' ]),
		ARGS_OR_ACCESSORS = arrayToHash([ '(', '[', '.' ]),

		ITERATION_KEYWORDS = arrayToHash([ 'for', 'while', 'do' ]),

		tree = [],
		fuid = 0,
		T = createTokenStream(tokenizer(data));

	/**
	 * Reads an entire list of names with refinements and returns it as an array of tokens. Leaves the tokenizer
	 * pointing at the first token after the symbol.
	 * TODO: Look for @name hints
	 */
	function readSymbol() {
		var symbol = [];

		if (!T.curr.is('name')) {
			throw error(T.curr.value, 'is not a valid symbol');
		}

		symbol.push(T.curr);
		T.next();

		while (true) {
			// foo.bar
			if (T.curr.is('punc', '.')) {
				T.next(); // skip .
				symbol.push(T.curr);
				T.next(); // skip identifier
			}

			// foo['bar']
			else if (T.curr.is('punc', '[')) {
				T.next(); // skip [

				// XXX: complex expressions are not supported at this time but maybe a bit more can be done to support
				// them later
				if (T.curr.is('string') && T.next.is('punc', ']')) {
					symbol.push(T.curr);
					T.next(); // skip string
					T.next(); // skip ]
				}
				else {
					T.nextUntil('punc', ']');
					return null;
				}
			}

			// symbol definition is done, or someone did something invalid
			else {
				break;
			}
		}

		return symbol;
	}

	/**
	 * Reads a list of function arguments and returns it as an array. Leaves the tokenizer pointing at the first token
	 * after the closing parenthesis of the arguments list.
	 */
	function readArguments() {
		var args = [];

		T.expect('punc', '(');
		T.next(); // skip (

		while (!T.curr.is('punc', ')')) {
			if (T.curr.is('eof')) {
				throw new Error('Unexpected end of file at ' + (T.curr.line + 1) + ':' + (T.curr.col + 1));
			}

			args.push(readStructure());

			if (T.curr.is('punc', ',')) {
				T.next(); // skip , but not )
			}
		}

		T.next(); // skip )

		return args;
	}

	function readExpression() {
		/**
		 * new X
		 * delete X
		 * foo()
		 * foo =
		 * x + y + z
		 * x++
		 * ++x
		 * void whatever
		 * typeof whatever
		 *
		 */
	}

	/**
	 * Reads a function. Leaves the tokenizer pointing at the first token after the end of the body of the function.
	 */
	function readFunction(/**boolean?*/ inExpression) {
		if (!T.curr.is('keyword', 'function')) {
			throw error('Not a function');
		}

		T.next(); // skip 'function'

		var parameters = [], body = [];

		if (T.curr.is('name') && inExpression) {
			// named function expressions can be referenced by name only from within the function’s body
			body.push({
				type: 'var',
				symbol: T.curr.value
			}, {
				type: 'assign',
				symbol: T.curr.value
			});

			T.next(); // skip identifier
		}

		T.expect('(');
		T.next(); // skip (

		if (!T.curr.is('punc', ')')) {
			do {
				parameters.push(T.curr);
			} while (T.next() && T.curr.is('punc', ',')); // skip identifier
		}

		T.expect(')');
		T.next(); // skip )

		return {
			type: 'function',
			parameters: parameters,
			body: readBlockOrStatement(body) // body is modified directly
		};
	}

	function readBlockOrStatement(block) {
		block = block || [];

		if (T.curr.is('punc', '{')) {
			return readBlock(block);
		}
		else {
			return block.push(readStatement());
		}
	}

	function readStatement() {
		var statement;

		// block
		if (T.curr.is('punc', '{')) {
			T.next(); // skip {

			statement = {
				type: 'block',
				value: readBlock()
			};

			T.next(); // skip }

			return statement;
		}

		// function declaration
		else if (T.curr.is('keyword', 'function')) {
			if (!T.peek.is('name')) {
				throw error('Expected identifier');
			}

			// It is easier to deal with function declarations if they appear to be
			// function expressions, so we just pretend they are
			return [ {
				type: 'var',
				symbol: T.peek.value
			}, {
				type: 'assign',
				symbol: T.peek.value,
				value: readFunction()
			} ];
		}

		// variable statement
		else if (T.curr.is('keyword', 'var') || T.curr.is('keyword', 'let')) {
			var keyword = T.curr.value;
			statement = [];

			T.next(); // skip 'var'

			while (!T.curr.is('punc', ';')) {
				statement.push({
					type: keyword,
					symbol: T.curr.value
				});

				T.next(); // skip identifier

				if (T.curr.is('punc', '=')) {
					statement.push({
						type: 'assign',
						symbol: T.prev.value,
						value: readExpression()
					});
				}

				if (T.curr.is('punc', ',')) {
					T.next(); // skip ,
				}
			}

			T.next(); // skip ;
			return statement;
		}

		// empty statement
		else if (T.curr.is('punc', ';')) {
			T.next(); // skip ;
			return [];
		}

		// if statement
		else if (T.curr.is('keyword', 'if')) {
			statement = {
				type: 'if',
				conditions: [],
				bodies: []
			};

			T.next(); // skip 'if'
			T.next(); // skip '('
			statement.condition = readExpression();
			T.next(); // skip ')'

		}

		// iteration statement
		else if (T.curr.is('keyword', ITERATION_KEYWORDS)) {

		}

		// continue/break statement
		else if (T.curr.is('keyword', { 'continue': 1, 'break': 1 })) {

		}

		// return statement
		else if (T.curr.is('keyword', 'return')) {
			T.next(); // skip 'return'
			return {
				type: 'return',
				value: readExpression()
			};
		}

		// with statement
		else if (T.curr.is('keyword', 'with')) {

		}

		// labelled statement
		else if (T.curr.is('name') && T.peek.is('punc', ':')) {

		}

		// switch statement
		else if (T.curr.is('keyword', 'switch')) {

		}

		// throw statement
		else if (T.curr.is('keyword', 'throw')) {

		}

		// try/catch/finally statement
		else if (T.curr.is('keyword', 'try')) {

		}

		// debugger statement
		else if (T.curr.is('name', 'debugger')) {
			T.next(); // skip 'debugger'
			return [];
		}

		// expression statement
		else if (!T.curr.is('punc', '{') && !T.curr.is('keyword', 'function')) {
			return readExpression();
		}

		// else wtf.
		throw error('Invalid statement', T.curr.type, T.curr.value);
	}


	/**
	 * Reads a statement from a function body. Only function calls, variable declarations, and assignments are parsed;
	 * everything else is ignored. Leaves the tokenizer pointing at the first token after the statement. Returns a
	 * single statement or an array of statements.
	 */
	function oldReadStatement() {
		// TODO: Don’t predefine what the statement is going to look like here; use a constructor instead
		var statement = {
			type: undefined, // 'call', 'assign', 'var', 'return', 'ternary'
			symbol: undefined, // name of object that has been called or assigned
			value: undefined // for calls, the list of arguments; for assignments, the assigned value;
			                 // for variable definitions, not sure yet TODO
		};

		// function call or assignment
		if (T.curr.is('name')) {
			statement.symbol = readSymbol();

			// function call
			if (T.curr.is('punc', '(')) {
				console.log('CALL:', statement.symbol.map(function reduce(item) {
					return Array.isArray(item) ? '[' + item.map(reduce).join('.') + ']' : item.value;
				}).join('.'));

				statement.type = 'call';
				statement.value = readArguments();
			}

			// assignment
			else if (T.curr.is('operator', '=')) {
				T.next(); // skip assignment operator

				statement.type = 'assign';
				statement.value = readStructure();
			}

			// something else weird
			else {
				var e = new Error('I really don’t know what to do with ' + T.curr.type + ' value ' + T.curr.value +
					' at ' + T.curr.line + ':' + T.curr.col);
				e.token = T.curr;
				throw e;
			}
		}

		// function declaration
		else if (T.curr.is('keyword', 'function')) {
			var functionValue = readStructure();

			statement = [
				{ type: 'var', symbol: functionValue.name },
				{ type: 'assign', symbol: functionValue.name, value: functionValue }
			];
		}

		// variable declaration
		else if (T.curr.is('keyword', 'var')) {
			// returning an array of statements is cool TODOC
			statement = [];

			T.next(); // skip keyword 'var'
			T.expect('name');

			// merge comments on 'var' keyword with comments on first defined symbol
			T.curr.comments_before = T.prev.comments_before.concat(T.curr.comments_before);

			do {
				if (T.peek.is('operator', '=')) {
					var innerStatement = readStatement();
					statement.push({
						type: 'var',
						symbol: innerStatement.symbol
					}, innerStatement);
				}
				else {
					statement.push({
						type: 'var',
						symbol: readSymbol()
					});
				}
			} while (T.curr.is('punc', ',') && T.next());
		}

		// naïve iife
		else if ((T.curr.is('punc', '(') || T.curr.is('operator', OPERATORS_RTL)) && T.peek.is('keyword', 'function')) {
			T.next(); // skip operator

			// merge comments on punctuation/operator with comments on function
			T.curr.comments_before = T.prev.comments_before.concat(T.curr.comments_before);
			statement.type = 'iife';
			statement.value = readStructure();

			if (T.curr.is('punc', ')')) {
				T.next(); // skip ) in the case of a call like (function () {})()
			}

			statement.args = readArguments();
		}

		// return value
		else if (T.curr.is('keyword', 'return')) {
			T.next(); // skip keyword 'return'
			statement.type = 'return';
			statement.value = readStructure();
		}

		// blocks to skip explicitly
		else if (T.curr.is('keyword', KEYWORDS_TO_SKIP)) {
			console.log('skipping', T.curr.value, 'block');

			T.next(); // skip keyword

			if (T.curr.is('punc', '(')) {
				console.log('skipping expr at ' + (T.curr.line+1) + ':' + (T.curr.col+1));
				T.nextUntil('punc', ')'); // skip expression
			}

			T.nextUntil('punc', T.curr.is('punc', '{') ? '}' : ';'); // skip entire block or statement

			return [];
		}

		// something we do not care about
		else {
			console.log('skipping', T.curr.type, T.curr.value);
			T.next(); // skip token
			return [];
		}

		return statement;
	}

	/**
	 * Reads literal data structures. Leaves the tokenizer pointing at the first token after the structure.
	 */
	function readStructure() {
		// Whether or not to skip the last token or not; keeps refs from stepping too far
		var skipLast = true,
			structure = {
				type: undefined, // function, array, object, boolean, null, undefined, string, num, regexp, name, ref, returnRef
				value: undefined,
				name: undefined // for function declarations
			};

		// function literal
		if (T.curr.is('keyword', 'function')) {
			structure.type = 'function';
			// TODO: Figure out how to transplant comments from earlier punctuation or operators
			structure.comments_before = T.curr.comments_before.slice(0);
			structure.value = {
				params: [],
				body: undefined
			};

			if (T.peek.is('name')) {
				T.next(); // skip 'function' keyword
				structure.name = T.curr.value;
			}
			else {
				structure.name = '*anon' + (++fuid);
			}

			T.next(); // skip function name or 'function' keyword
			T.expect('punc', '(');

			while (T.next() && !T.curr.is('punc', ')')) {
				if (T.curr.is('punc', ',')) {
					continue;
				}

				structure.value.params.push(T.curr);
			}

			T.next(); // skip )
			T.expect('punc', '{');
			T.next(); // skip {

			structure.value.body = parseFunctionBody();

			// } skipped at end of conditional
		}

		// expression
		else if (T.curr.is('punc', '(')) {
			console.log('expression not implemented ' + (T.curr.line+1) + ':' + (T.curr.col+1));
			structure.type = 'expression';
			structure.value = T.nextUntil('punc', ')');

			// TODO: Could be even more after the expression…
		}

		// array literal
		else if (T.curr.is('punc', '[')) {
			structure.type = 'array';
			structure.value = [];
			// TODO: Improve consistency of complex object comments
			structure.comments_before = T.curr.comments_before;

			T.next(); // skip [

			while (!T.curr.is('punc', ']')) {
				structure.value.push(readStructure());

				if (T.curr.is('punc', ',')) {
					T.next(); // skip ,
				}
			}

			// ] skipped at end of conditional
		}

		// object literal
		else if (T.curr.is('punc', '{')) {
			structure.type = 'object';
			structure.value = T.nextUntil('punc', '}');
			console.log('object literal not implemented');
		}

		// boolean literal
		else if (T.curr.is('name', 'true') || T.curr.is('name', 'false')) {
			structure.type = 'boolean';
			structure.value = !!T.curr.value;
		}

		// null primitive
		else if (T.curr.is('name', 'null')) {
			structure.type = 'null';
			structure.value = null;
		}

		// undefined primitive
		else if (T.curr.is('name', 'undefined')) {
			structure.type = 'undefined';
			structure.value = undefined;
		}

		// reference or function call or maybe an entire expression TODOC :|
		else if (T.curr.is('name')) {
			structure.type = 'ref';
			structure.value = readSymbol();

			if (T.curr.is('punc', '(')) {
				structure.type = 'returnRef';
				structure.args = readArguments();
			}

			if (!T.peek.nlb && !T.peek.is('punc', ';')) {
				structure.incompleteExpression = true;
				T.nextUntil('punc', ';');
			}

			skipLast = false;
		}

		// string, number, regular expression literals
		// TODO: Might want to do something else here instead depending upon what ends up being done with other stuff
		else if (T.curr.is('string') || T.curr.is('num') || T.curr.is('regexp')) {
			structure.type = T.curr.type;
			structure.value = T.curr;
		}

		// object instance
		else if (T.curr.is('operator', 'new')) {
			T.next(); // skip 'new' operator

			structure.type = 'instance';
			structure.value = readStatement();
		}

		// all others
		else {
			throw new Error('Unknown structure type ' + T.curr.type + ' with value ' + T.curr.value + ' at ' +
				(T.curr.line + 1) + ':' + (T.curr.col + 1));

			structure.type = T.curr.type;
			structure.value = T.curr;
		}

		skipLast && T.next(); // skip last token in structure

		return structure;
	}

	/**
	 * Reads statements inside a block. Leaves the tokenizer pointing at the last token of the structure.
	 */
	function readBlock(/**Array*/ block) {
		while (!T.curr.is('punc', '}') && !T.curr.is('eof')) {
			block = block.concat(readStatement());
		}

		return block;
	}

	return readBlock([]);
}

/* -----[ Main ] ----- */

// TODO: Load from a build profile or something
var config = {
	baseUrl: '/mnt/devel/web/dojo-trunk/',

	moduleMap: {
		dojo: 'dojo',
		dijit: 'dijit',
		dojox: 'dojox'
	}
};

var modules = {};

// from dojo loader
function resolveRelativeId(path) {
	var result = [], segment, lastSegment;
	path = path.split('/');
	while (path.length) {
		segment = path.shift();
		if (segment === '..' && result.length && lastSegment != '..') {
			result.pop();
		}
		else if(segment != '.') {
			result.push((lastSegment = segment));
		} // else ignore '.'
	}

	return result.join('/');
}

function getModuleIdFromPath(path) {
	var result = resolveRelativeId(path);

	for (var module in config.moduleMap) {
		var pathPrefix = config.baseUrl + config.moduleMap[module];

		if (pathPrefix.charAt(-1) !== '/') {
			pathPrefix += '/';
		}

		if (result.indexOf(pathPrefix) === 0) {
			result = result.substr(pathPrefix.length);
			break;
		}
	}

	result = result.replace(/^\/|\.js$/g, '');

	// TODO: Update to use more traditional AMD module map pattern
	return result === 'main' ? module : module + '/' + result;
}

function processFile(path) {
	var fileModuleId = getModuleIdFromPath(path), tree;

	console.log('Processing', fileModuleId);

	tree = parse(fs.readFileSync(path, 'utf8'));

	console.log(require('util').inspect(tree, null, null));
}

/*var token;
var getToken = tokenizer(fs.readFileSync(process.argv[2], 'utf8'));

while ((token = getToken()).type !== 'eof') {
	console.dir(token);
}

process.stdout.end();
process.exit(0);*/

process.argv.slice(2).forEach(function processPath(parent, path) {
	path = (parent + (path ? '/' + path : '')).replace(/\/{2,}/g, '/');

	var stats = fs.statSync(path);

	if (stats.isDirectory()) {
		fs.readdirSync(path).forEach(processPath.bind(this, path));
	}
	else if (stats.isFile() && /\.js$/.test(path)) {
		processFile(path);
	}
});