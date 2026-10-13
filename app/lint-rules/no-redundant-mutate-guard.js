/**
 * Flags `if (!Store.get().map) return` when everything after it is a mutation:
 * `Mutation.run` and the `Edit` calls built on it already do nothing when no map is open.
 */
const MUTATIONS = { Mutation: ["run"], Edit: ["locations", "values", "work"] };

function isOpenMapRead(node) {
	return (
		node.type === "MemberExpression" &&
		node.property.name === "map" &&
		node.object.type === "CallExpression" &&
		node.object.callee.type === "MemberExpression" &&
		node.object.callee.object.name === "Store" &&
		node.object.callee.property.name === "get"
	);
}

function noMapDisjunct(test) {
	if (test.type === "LogicalExpression" && test.operator === "||")
		return noMapDisjunct(test.left) || noMapDisjunct(test.right);
	return test.type === "UnaryExpression" && test.operator === "!" && isOpenMapRead(test.argument);
}

function isBareReturn(stmt) {
	if (stmt.type === "ReturnStatement") return !stmt.argument;
	return stmt.type === "BlockStatement" && stmt.body.length === 1 && isBareReturn(stmt.body[0]);
}

function isMutationCall(node) {
	if (!node) return false;
	if (node.type === "AwaitExpression") return isMutationCall(node.argument);
	if (node.type === "UnaryExpression" && node.operator === "void")
		return isMutationCall(node.argument);
	if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
	return MUTATIONS[node.callee.object.name]?.includes(node.callee.property.name) ?? false;
}

function isMutationStatement(stmt) {
	if (stmt.type === "ExpressionStatement") return isMutationCall(stmt.expression);
	if (stmt.type === "ReturnStatement") return isMutationCall(stmt.argument);
	return false;
}

export default {
	meta: {
		type: "suggestion",
		messages: {
			redundantGuard:
				"Redundant open-map guard: Mutation.run and the Edit calls already do nothing when no map is open.",
		},
	},
	create(context) {
		return {
			":function"(node) {
				const stmts = node.body?.type === "BlockStatement" ? node.body.body : null;
				if (!stmts) return;
				stmts.forEach((stmt, i) => {
					if (stmt.type !== "IfStatement" || stmt.alternate) return;
					if (!noMapDisjunct(stmt.test) || !isBareReturn(stmt.consequent)) return;
					const rest = stmts.slice(i + 1);
					if (rest.length && rest.every(isMutationStatement))
						context.report({ node: stmt, messageId: "redundantGuard" });
				});
			},
		};
	},
};
