# カスタムプロバイダー

ICEでは、追加のLLMやAPIサービスを統合するためのカスタムプロバイダーを作成することができます。このガイドでは、シンプルな例から高度な実装まで、独自のプロバイダーを作成するプロセスを説明します。

## 基本構造

ICEのカスタムプロバイダーは、特定の構造を持つJavaScriptファイルです。メタデータブロックから始まり、メインのプロセスハンドラーを含みます。

### メタデータブロック

メタデータブロックは、プロバイダーのプロパティと設定を定義します：

```javascript
// ==ICEProvider==
// @name                私のカスタムプロバイダー
// @version             1.0
// @description         ICEのためのシンプルなカスタムプロバイダー
// @author              あなたの名前
// @license             MIT
// @variableRequired    APIKey
// @variableOptional    Temperature=0.7
// ==/ICEProvider==
```

### プロセスハンドラー

プロバイダーのメインロジックは、プロセスメッセージリスナーで処理されます：

```javascript
process.on('message', (message) => {
  // ここで受信メッセージを処理します
});
```

## シンプルな例：エコープロバイダー

ユーザーの入力をエコーバックする簡単なプロバイダーから始めましょう：

```javascript
// ==ICEProvider==
// @name                エコープロバイダー
// @version             1.0
// @description         ユーザー入力をエコーバックするシンプルなプロバイダー
// @author              あなたの名前
// @license             MIT
// ==/ICEProvider==

process.on('message', (message) => {
  if (message.type === 'getCompletion') {
    const userMessage = message.messageTrail[message.messageTrail.length - 1].content;
    const response = `エコー: ${userMessage}`;
    
    process.send({
      type: 'done',
      requestID: message.requestID,
      finalText: response
    });
  }
});
```

このプロバイダーは、単にユーザーからの最後のメッセージを取得し、それをエコーバックします。

## 高度な例：API統合

次に、外部APIと統合するより高度なプロバイダーを作成しましょう：

```javascript
// ==ICEProvider==
// @name                天気APIプロバイダー
// @version             1.0
// @description         天気APIを使用して天気情報を提供します
// @author              あなたの名前
// @license             MIT
// @variableRequired    APIKey
// @variableRequired    City
// ==/ICEProvider==

const https = require('https');

process.on('message', (message) => {
  if (message.type === 'getCompletion') {
    const config = message.config;
    const apiKey = config.APIKey;
    const city = config.City;

    const url = `https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${city}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const weatherData = JSON.parse(data);
          const response = `${city}の現在の天気: ${weatherData.current.condition.text}、気温: ${weatherData.current.temp_c}°C`;

          process.send({
            type: 'done',
            requestID: message.requestID,
            finalText: response
          });
        } catch (error) {
          process.send({
            type: 'error',
            requestID: message.requestID,
            error: '天気データの解析に失敗しました'
          });
        }
      });
    }).on('error', (error) => {
      process.send({
        type: 'error',
        requestID: message.requestID,
        error: `天気データの取得中にエラーが発生しました: ${error.message}`
      });
    });
  }
});
```

このプロバイダーは、天気APIと統合して指定された都市の現在の天気情報を提供します。

## ベストプラクティス

1. **エラー処理**: 常に適切なエラー処理を含め、ユーザーに意味のあるフィードバックを提供してください。
2. **設定**: メタデータブロックを使用して、必須および任意の変数を定義してください。
3. **非同期操作**: APIコールやその他の非同期操作には、プロミスやコールバックを適切に処理してください。
4. **セキュリティ**: APIキーなどの機密情報をプロバイダーコードに直接露出させないでください。

## プロバイダーのテスト

1. プロバイダースクリプトをICEのプロバイダーディレクトリに保存します。
2. VSCodeを再起動するか、ICE拡張機能をリロードします。
3. 新しいチャットを作成し、リストからカスタムプロバイダーを選択します。

## 高度なトピック

- **ストリーミングレスポンス**: リアルタイムレスポンスのために `stream` メッセージタイプを実装します。
- **添付ファイルの処理**: プロバイダースクリプトの `@_needAttachmentPreprocessing` と `@_attachmentFilter` メタデータを使用して、ファイル添付の処理を可能にします。これにより、基礎となるAPIがサポートしている場合、画像分析やドキュメント処理などのマルチモーダルな相互作用が可能になります。
- **カスタムUI**: `variableSecure` と `variableRequired` メタデータを利用して、カスタマイズされた設定UIを作成します。

より複雑な実装については、ICEリポジトリの組み込みプロバイダーを例として参照してください。

## 添付ファイル処理に関する注意

ICEは、添付ファイルを明示的にサポートしていないプロバイダーのために、デフォルトの添付ファイル処理メカニズムを実装しています。この動作により、異なるプロバイダー間で最大限の互換性が確保されます。以下がその仕組みです：

1. **パス解決**: 添付ファイルのURLが既に有効な形式（データURLまたはhttpURL）でない場合、絶対パスに変換されます。

2. **前処理オプション**: プロバイダーは、メタデータで `_needAttachmentPreprocessing` を false に設定することで、添付ファイルの前処理をオプトアウトできます。

3. **テキストファイルの処理**: テキストファイルの場合、内容が直接メッセージ内容に挿入され、ファイル名がXML風のタグで囲まれます。

4. **バイナリファイルの処理**: バイナリファイルは直接送信されません。代わりに、プレースホルダーメッセージが挿入され、ユーザーに警告が表示されます。

5. **Base64エンコードデータ**: 添付ファイルがbase64エンコードされたデータURLとして提供される場合、処理前にデコードされます。

このデフォルトの動作により、プロバイダー間でテキストベースの添付ファイルを処理できるようになり、サポートされていないバイナリファイルも適切に管理されます。これにより、ネイティブの添付ファイルサポートがないプロバイダーでも、メッセージコンテキスト内でテキストベースのファイル内容を扱うことができます。

独自の添付ファイル処理を実装するプロバイダー（OpenAI互換プロバイダーの例など）の場合、このデフォルトの前処理はスキップされ、基礎となるAPIがサポートしている場合、画像やその他のバイナリ形式を含む様々なファイルタイプのより専門的な処理が可能になります。
