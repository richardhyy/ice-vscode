# 変数とプレースホルダー

ICEは、ユーザーメッセージ/プロンプトとシステムプロンプトの両方で変数とプレースホルダーを使用することで、強力な機能を提供します。この機能により、LLMとのより動的でコンテキストを意識したインタラクションが可能になります。

## ユーザーメッセージとプロンプト

カスタム変数をユーザーメッセージやプロンプトで使用することで、より柔軟で再利用可能なコンテンツを作成できます。以下がこの機能の使用方法です：

### 変数の宣言

1. チャットビューでメッセージを右クリックし、「設定更新を挿入」を選択します。
2. 設定エディタで、以下の形式を使用して変数を宣言します：
```
$変数名 = 変数の値...
```
3. 1回の設定更新で複数の変数を宣言できます。

### 変数の使用

宣言後、これらの変数をメッセージで使用できます：

1. ユーザーメッセージでは、`{{ 変数名 }}`と入力して変数プレースホルダーを挿入します。
2. ICEは変数名の素早い挿入のために自動補完を提供します。

### 例

設定更新：
```
$Doc = 私の名前は太郎です。
$TargetLanguage = フランス語
```

ユーザーメッセージ：
```
"{{ Doc }}"を{{ TargetLanguage }}に翻訳してください。
```

これは以下のように展開されます：
```
"私の名前は太郎です。"をフランス語に翻訳してください。
```

![変数の例](../images/variables.png)

## システムプロンプト

システムプロンプトでは、ICEは様々な組み込み環境変数をサポートしています。これらは、情報を手動で更新する必要なく、LLMにコンテキストを意識した情報を提供するのに特に有用です。

### 利用可能な環境変数

| 変数 | 説明 | 出力例 |
|----------|-------------|----------------|
| {{ TIME_NOW }} | 24時間形式の現在時刻 | 14:30:45 |
| {{ TIME_NOW_12H }} | 12時間形式の現在時刻 | 09:41:23 PM |
| {{ DATE_TODAY }} | ISO形式の今日の日付 | 2024-07-22 |
| {{ DATE_TODAY_SHORT }} | 短い形式の今日の日付 | 07/22/24 |
| {{ DATE_TODAY_LONG }} | 長い形式の今日の日付 | July 22, 2024 |

### 環境変数の使用

これらの変数をシステムプロンプトに直接含めることができます。システムプロンプトがLLMに送信されるときに、自動的に対応する値に置き換えられます。

システムプロンプトでの使用例：
```
あなたはAIアシスタントです。現在の日付は{{ DATE_TODAY_LONG }}で、時刻は{{ TIME_NOW_12H }}です。
```

これは以下のように展開される可能性があります：
```
あなたはAIアシスタントです。現在の日付は2024年7月22日で、時刻は午後9時41分23秒です。
```

## ベストプラクティス

1. **一貫した命名**: 変数を理解しやすく使いやすくするために、明確で一貫した命名規則を使用してください。