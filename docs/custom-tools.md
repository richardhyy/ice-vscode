# Custom Tools

Tools let the model call your own code and use the result in its answer. An ICE tool is a small, readable JavaScript file you can open and edit.

This page is intentionally short. You can paste it to the LLM and ask it to write a tool for you (see [Let a model write it](#let-a-model-write-it)).

## A tool at a glance

Here is a complete built-in tool, `fetch_url`:

```javascript
// ==ICETool==
// @name         fetch_url
// @description  Fetch the text content of a web page by URL and return it.
// ==/ICETool==

module.exports = {
  arguments: {
    url: { type: "string", description: "The absolute URL to fetch (http or https)." },
  },

  async call({ url }) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed (HTTP ${response.status}).`);
    }
    return await response.text();
  },
};
```

That is the whole thing: a header that names the tool, and an object that describes its arguments and does the work.

## The header

```javascript
// ==ICETool==
// @name         fetch_url
// @description  Fetch the text content of a web page by URL and return it.
// ==/ICETool==
```

The header is read **without running the script**, so ICE can show your tool in the picker before it ever executes.

| Field          | Required | Description                                              |
| -------------- | -------- | -------------------------------------------------------- |
| `@name`        | Yes      | The tool's identifier, shown to you and to the model.    |
| `@description` | Yes      | What the tool does. The model uses this to decide when to call it. |
| `@dynamic`     | No       | Set to `true` for a [dynamic source](#dynamic-sources) that exposes many tools. |

## The export

```javascript
module.exports = {
  arguments: { /* … */ },
  async call(args, context) { /* … */ },
};
```

### arguments

`arguments` describes the parameters the model must generate, keyed by name. Each entry co-locates the type, a short description, and any constraints:

```javascript
arguments: {
  city:  { type: "string",  description: "The city to look up." },
  units: { type: "string",  description: "Temperature units.", enum: ["C", "F"], optional: true },
  limit: { type: "integer", description: "How many results.", range: [1, 10] },
}
```

| Key           | Description                                                         |
| ------------- | ----------------------------------------------------------------- |
| `type`        | `"string"`, `"integer"`, `"number"`, `"boolean"`, `"array"`, or `"object"`. |
| `description` | What the argument means. Keep it short — long descriptions cost context. |
| `optional`    | Arguments are **required by default**; set `true` to make one optional. |
| `enum`        | Restrict the value to a fixed list.                               |
| `range`       | `[min, max]` bounds for a number.                                |
| `items`       | The element schema for an `array`.                               |

### call

```javascript
async call(args, context) {
  // args is an object matching your `arguments`.
  return "the result the model sees";
}
```

- **Return a string** and the model receives it as the tool's result.
- **Throw an error** to tell the model something went wrong (`throw new Error("Cannot reach the database.")`). The message is handed back to the model, not shown as a crash.
- You may also return `{ content, isError }` for finer control.
- `context` carries `{ config }` today, and is where a session API will live in future.

### Read-only tools

If a tool has no side effects (it only reads), mark it so ICE doesn't ask for approval before each call:

```javascript
module.exports = {
  readOnly: true,
  arguments: { /* … */ },
  async call(args) { /* … */ },
};
```

## Where tools live

- **Built-in tools** ship with ICE and are always available.
- **Your own tools** can live anywhere. Point at a script by path — for example, one sitting next to your `.chat` file — so an experiment can carry its own tools and travel with the conversation.

Enable tools for a conversation from the **Tools** control in the message box. Your selection is recorded as a node in the `.chat` file, so it is visible, editable, and forkable like everything else.

## Dynamic sources

A single script can expose **many** tools by acting as a source. Instead of `arguments` + `call(args)`, export `listTools` + `call(name, args)`:

```javascript
// ==ICETool==
// @name         my_source
// @description  Exposes a set of tools discovered at runtime.
// @dynamic      true
// ==/ICETool==

module.exports = {
  async listTools(config) {
    return [
      { name: "add",      description: "Add two numbers.", arguments: { a: { type: "number" }, b: { type: "number" } } },
      { name: "subtract", description: "Subtract two numbers.", arguments: { a: { type: "number" }, b: { type: "number" } } },
    ];
  },

  async call(name, args, context) {
    if (name === "add")      return String(args.a + args.b);
    if (name === "subtract") return String(args.a - args.b);
    throw new Error(`Unknown tool: ${name}`);
  },
};
```

This is how ICE bridges external systems: an MCP server, for instance, is just a dynamic source that lists the server's tools and forwards calls to it.

## Let a model write it

Because the format is this small, the fastest way to make a tool is to describe what you want and let a model write it. Paste this page into a chat and ask, for example:

> Using the ICE tool format above, write a tool that returns the current time in a given timezone.

Then save the result as a `.js` file and point ICE at it.
