// xiaobai-switch managed extension — DO NOT EDIT (regenerated on apply).
//
// Gemini-family upstreams behind OpenAI-compatible relays validate tool
// parameter schemas strictly: every node needs a concrete `type` and
// `anyOf`/`oneOf` unions are rejected outright ("outputSchema schema didn't
// specify the schema type field", HTTP 400). omp's openai-completions wire
// format legitimately contains such unions, so before the request goes out we
// flatten them into the single-type form Gemini accepts:
//   - drop `{ type: "null" }` branches, collapse single-branch unions
//   - multi-branch unions degrade to their first non-null branch (lossy)
//   - `type: ["T", "null"]` narrows to `"T"`
//   - nodes carrying `properties` / `items` / `enum` get an inferred `type`
// Non-Gemini models are untouched, so this is safe to leave installed.

function inferType(node) {
	if (typeof node.type === "string") return node.type;
	if (Array.isArray(node.type)) return node.type.find((t) => t !== "null");
	if ("properties" in node || "additionalProperties" in node) return "object";
	if ("items" in node || "prefixItems" in node) return "array";
	return undefined;
}

/** Collapse one combinator node into a Gemini-acceptable schema. */
function collapse(node) {
	const branches = (node.anyOf ?? node.oneOf ?? []).filter(
		(b) => b && typeof b === "object" && b.type !== "null",
	);
	const rest = { ...node };
	delete rest.anyOf;
	delete rest.oneOf;
	if (!branches.length) return rest;
	// Single survivor: merge it upward so keywords like `description` survive.
	let best = branches[0];
	if (branches.length > 1) {
		// Lossy: prefer object > array > string/number/boolean, else first.
		const rank = { object: 4, array: 3, string: 2, number: 2, boolean: 1 };
		best = [...branches].sort((a, b) => (rank[b.type] ?? 0) - (rank[a.type] ?? 0))[0];
	}
	return { description: rest.description, ...best, ...(!rest.description && {}) };
}

function walk(node) {
	if (Array.isArray(node)) {
		for (const item of node) walk(item);
		return;
	}
	if (!node || typeof node !== "object") return;

	for (const key of ["$schema", "$defs", "$id", "$anchor"]) delete node[key];

	let replacement;
	if ("anyOf" in node || "oneOf" in node) replacement = collapse(node);

	if (replacement) {
		for (const k of Object.keys(node)) delete node[k];
		Object.assign(node, replacement);
	}

	const t = inferType(node);
	if (t && typeof node.type !== "string") node.type = t;
	else if (t && node.type !== t) node.type = t;

	walk(node.properties ?? {});
	walk(node.items);
	walk(node.prefixItems);
	if (node.additionalProperties && typeof node.additionalProperties === "object")
		walk(node.additionalProperties);
}

export default function (pi) {
	pi.on("before_provider_request", async (event) => {
		const payload = event?.payload;
		if (!payload || typeof payload !== "object") return undefined;
		const body = payload.body && typeof payload.body === "object" ? payload.body : payload;
		if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined;
		const model = typeof body.model === "string" ? body.model : "";
		if (!/(^|[/:])?(gemini|gemma)/i.test(model)) return undefined;
		try {
			for (const tool of body.tools) {
				const schema = tool?.parameters ?? tool?.function?.parameters;
				if (schema && typeof schema === "object") walk(schema);
			}
		} catch {
			// Never break the request over cleanup; upstream will report if invalid.
		}
		return payload;
	});
}
