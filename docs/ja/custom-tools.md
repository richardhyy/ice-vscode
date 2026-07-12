# カスタムツール

ツールを使うと、モデルがあなた自身のコードを呼び出し、その結果を回答に利用できます。ICEのツールは、開いて編集できる小さく読みやすいJavaScriptファイルです。

このページは意図的に簡潔にしています。LLMに貼り付けて、代わりにツールを書いてもらうこともできます（[モデルに書かせる](#let-a-model-write-it)を参照）。

## 一目でわかるツール

これは組み込みツール `fetch_url` の完全な例です。

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

これがすべてです。ツールに名前を付けるヘッダーと、引数を記述して処理を行うオブジェクトだけです。

## ヘッダー

```javascript
// ==ICETool==
// @name         fetch_url
// @description  Fetch the text content of a web page by URL and return it.
// ==/ICETool==
```

ヘッダーは**スクリプトを実行せずに**読み取られるため、ICEは実行前にツールをピッカーに表示できます。

| フィールド      | 必須 | 説明                                                     |
| -------------- | ---- | -------------------------------------------------------- |
| `@name`        | はい | ツールの識別子。あなたとモデルの両方に表示されます。       |
| `@description` | はい | ツールの機能。モデルはこれをもとに呼び出すかどうかを判断します。 |
| `@dynamic`     | いいえ | 多数のツールを公開する[動的ソース](#dynamic-sources)の場合に `true` を設定します。 |

## エクスポート

```javascript
module.exports = {
  arguments: { /* … */ },
  async call(args, context) { /* … */ },
};
```

### arguments

`arguments` は、モデルが生成すべきパラメータを名前をキーとして記述します。各エントリには型、短い説明、および制約をまとめて記述します。

```javascript
arguments: {
  city:  { type: "string",  description: "The city to look up." },
  units: { type: "string",  description: "Temperature units.", enum: ["C", "F"], optional: true },
  limit: { type: "integer", description: "How many results.", range: [1, 10] },
}
```

| キー          | 説明                                                              |
| ------------- | ----------------------------------------------------------------- |
| `type`        | `"string"`、`"integer"`、`"number"`、`"boolean"`、`"array"`、または `"object"`。 |
| `description` | 引数の意味。短く保ってください。長い説明はコンテキストを消費します。 |
| `optional`    | 引数は**既定で必須**です。省略可能にするには `true` を設定します。   |
| `enum`        | 値を固定のリストに制限します。                                    |
| `range`       | 数値の `[min, max]` 境界。                                        |
| `items`       | `array` の要素スキーマ。                                          |

### call

```javascript
async call(args, context) {
  // args is an object matching your `arguments`.
  return "the result the model sees";
}
```

- **文字列を返す**と、モデルはそれをツールの結果として受け取ります。
- **エラーをスローする**と、モデルに問題が起きたことを伝えられます（`throw new Error("Cannot reach the database.")`）。メッセージはクラッシュとしてではなく、モデルに返されます。
- より細かく制御するために `{ content, isError }` を返すこともできます。
- `context` は現在 `{ config }` を保持しており、将来的にはここにセッションAPIが加わります。

### 読み取り専用ツール

副作用のないツール（読み取りのみ）は、その旨を示すことで、ICEが呼び出しごとに承認を求めないようにできます。

```javascript
module.exports = {
  readOnly: true,
  arguments: { /* … */ },
  async call(args) { /* … */ },
};
```

## ツールの配置場所

- **組み込みツール**はICEに同梱され、常に利用できます。
- **自作のツール**はどこに置いても構いません。パスでスクリプトを指定します。たとえば `.chat` ファイルの隣に置けば、実験がそれ自身のツールを持ち運び、会話とともに移動できます。

会話でツールを有効にするには、メッセージボックスの**Tools**コントロールから行います。あなたの選択は `.chat` ファイル内のノードとして記録されるため、他のすべてと同じように可視・編集・フォークが可能です。

## 動的ソース :id=dynamic-sources

1つのスクリプトが、ソースとして振る舞うことで**多数の**ツールを公開できます。`arguments` + `call(args)` の代わりに、`listTools` + `call(name, args)` をエクスポートします。

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

これはICEが外部システムを橋渡しする仕組みでもあります。たとえばMCPサーバーは、サーバーのツールを一覧し、その呼び出しを転送するだけの動的ソースにすぎません。

## モデルに書かせる :id=let-a-model-write-it

このフォーマットはとても小さいため、ツールを作る最も速い方法は、望むものを説明してモデルに書かせることです。このページをチャットに貼り付けて、たとえば次のように尋ねてみてください。

> 上記のICEツール形式を使って、指定したタイムゾーンの現在時刻を返すツールを書いてください。

そして結果を `.js` ファイルとして保存し、ICEでそのパスを指定します。
