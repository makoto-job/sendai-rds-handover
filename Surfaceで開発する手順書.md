# Surfaceで引継帳アプリを開発する手順書

## 最初の1回だけやること（準備）

### 1. Gitをインストールする

1. Surfaceでブラウザを開く
2. https://git-scm.com にアクセス
3. 「Download for Windows」をクリック
4. ダウンロードしたファイルを開いて、全部「Next」で進めてインストール

### 2. アプリのコードをダウンロードする

1. スタートメニューから「PowerShell」を開く
2. 以下を1行ずつコピーして貼り付け、Enterを押す

```
cd Desktop
git clone https://github.com/makoto-job/sendai-rds-handover.git
```

3. デスクトップに「sendai-rds-handover」フォルダができる
4. GitHubのユーザー名とパスワードを聞かれたら：
   - ユーザー名: `makoto-job`
   - パスワード: GitHubで作ったトークン（ghp_で始まる文字列）

### 3. 自分の名前をGitに登録する

PowerShellで以下を実行：

```
git config --global user.name "makoto-job"
git config --global user.email "272985488+makoto-job@users.noreply.github.com"
```

---

## 毎回やること

### 開発を始めるとき

1. PowerShellを開く
2. アプリのフォルダに移動する

```
cd Desktop\sendai-rds-handover
```

3. Mac miniでの変更を取り込む

```
git pull
```

4. コードを編集する（メモ帳、VS Codeなど好きなエディタで）

### 動作確認するとき

`index.html` をダブルクリックすればブラウザで開ける。

### 作業が終わったとき

1. PowerShellで以下を順番に実行：

```
git add .
```

```
git commit -m "何を変えたか書く（例：ボタンの色を変更）"
```

```
git push
```

2. これでGitHubにアップロードされる
3. Mac miniに戻ったら `git pull` で最新を取り込める

---

## よくあるトラブル

### 「error」や赤い文字が出た

- まず落ち着いて、エラーメッセージをコピーしてClaudeに聞く

### git pullしたら「conflict」と出た

- Mac miniとSurfaceで同じファイルの同じ場所を変えた場合に起きる
- Claudeに聞けば解決してくれる

### パスワードを毎回聞かれてめんどくさい

PowerShellで以下を実行すれば、1回入力すれば覚えてくれる：

```
git config --global credential.helper manager
```

---

## まとめ（3ステップだけ覚えればOK）

| タイミング | コマンド | 意味 |
|-----------|---------|------|
| 作業を始める前 | `git pull` | 最新のコードをもらう |
| 作業が終わったら | `git add .` → `git commit -m "内容"` → `git push` | 変更をアップロード |
| Mac miniに戻ったら | `git pull` | Surfaceの変更をもらう |
