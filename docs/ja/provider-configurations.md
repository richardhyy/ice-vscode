# ビルトインプロバイダの設定

ICEには複数のビルトインプロバイダが付属しており、それぞれに独自の設定オプションがあります。これらの設定を理解することで、異なるLLMプロバイダとのやり取りを微調整できます。このガイドでは、OpenAI互換プロバイダを例に使用して、共通の設定変数について説明します。

## OpenAI互換プロバイダの設定

OpenAI互換プロバイダは、OpenAIのAPIや類似のサービスと連携するように設計されています。以下が主要な設定変数です：

### 必須変数

- `APIKey`: APIサービスの認証キー。LLMにアクセスするために不可欠です。

- `APIHost`: APIサーバーのホスト名（例：`api.openai.com`）。OpenAI APIフォーマットと互換性のある代替ホストを使用できるようにします。

- `APIPath`: チャット完了のための特定のエンドポイントパス（例：`/v1/chat/completions`）。使用するAPIサービスによって異なる場合があります。

- `Model`: 使用する特定の言語モデル（例：`gpt-3.5-turbo`）。異なるモデルには異なる能力とパフォーマンス特性があります。

- `MaxTokensToSample`: モデルが生成すべき最大トークン数。これは出力の長さを制御するのに役立ちます。

- `SystemPrompt`: AIアシスタントの振る舞いや役割を設定するプロンプト。AIの応答のコンテキストとパーソナリティを定義するのに役立ちます。

### オプション変数

- `Temperature`: モデルの出力のランダム性を制御する0から1の間の値。高い値（例：0.8）は出力をよりランダムにし、低い値（例：0.2）はより焦点を絞った決定論的なものにします。

- `LogitBias`: 出力に特定のトークンが現れる可能性を調整できるJSONオブジェクト。特定の単語やフレーズを促進または抑制するために使用できます。

- `AdditionalHeaders`: APIリクエストに含める追加のHTTPヘッダーを指定するJSONオブジェクト。カスタム認証スキームやその他のAPI固有の要件に役立ちます。

## 設定変数の理解

### API設定
- `APIKey`、`APIHost`、`APIPath`は協力してLLMサービスへの接続を確立します。これらはリクエストの送信先と認証方法を決定します。

### モデルの動作
- `Model`は使用する特定のAIモデルを選択します。異なるモデルは、能力、知識のカットオフ日、パフォーマンス特性が異なる場合があります。
- `SystemPrompt`はAIの初期コンテキストを設定し、会話中に想定する「パーソナリティ」や役割を効果的に与えます。

### 出力制御
- `MaxTokensToSample`はAIの応答の長さを制限します。これはコストを管理し、簡潔な回答を確保するのに役立ちます。
- `Temperature`は出力の創造性とランダム性に影響します。低い値は事実に基づいた予測可能な応答に適していますが、高い値はより創造的で多様な出力につながる可能性があります。
- `LogitBias`はモデルのトークン選択プロセスを細かく制御でき、出力のスタイルや内容を導くために使用できます。

### 高度な使用法
- `AdditionalHeaders`は、異なるAPI実装との連携やリクエストにカスタムメタデータを追加するための柔軟性を提供します。

## ベストプラクティス

1. **APIキーのセキュリティ**: `APIKey`は常に安全に保管し、決して公開しないでください。

2. **カスタマイズ**: 異なる`SystemPrompt`値を試して、AIの動作を特定のユースケースに合わせてカスタマイズしてください。

3. **パフォーマンスチューニング**: `Temperature`と`MaxTokensToSample`を調整して、応答の品質、長さ、生成速度のバランスを取ってください。

4. **コスト管理**: `MaxTokensToSample`の設定に注意してください。高い値はAPI使用量とコストを増加させる可能性があります。

5. **互換性**: 代替APIホストを使用する場合は、指定した`Model`がそのサービスでサポートされていることを確認してください。