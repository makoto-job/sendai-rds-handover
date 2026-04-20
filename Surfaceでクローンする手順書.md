# Surfaceにアプリのコードをダウンロード（クローン）する手順

## やることの流れ

```
Gitインストール → PowerShell開く → コマンド入力 → 完了！
```

---

## ステップ1：Gitをインストールする

1. Surfaceでブラウザ（Edgeなど）を開く
2. アドレスバーに `https://git-scm.com` と入力してEnter
3. 画面に大きく「Download for Windows」と出るのでクリック
4. 「64-bit Git for Windows Setup」をクリック
5. ダウンロードしたファイルをダブルクリック
6. ひたすら「Next」→「Next」→「Install」→「Finish」でOK

### インストールできたか確認する

1. スタートメニューで「PowerShell」と検索して開く
2. 以下を入力してEnter

```
git --version
```

3. `git version 2.xx.x` のように表示されたら成功

---

## ステップ2：自分の名前を登録する（初回だけ）

PowerShellで以下を1行ずつ入力してEnter：

```
git config --global user.name "makoto-job"
```

```
git config --global user.email "272985488+makoto-job@users.noreply.github.com"
```

---

## ステップ3：パスワードを覚えさせる（初回だけ）

これをやっておくと、毎回パスワードを聞かれなくなる：

```
git config --global credential.helper manager
```

---

## ステップ4：コードをダウンロードする

1. PowerShellで以下を入力してEnter

```
cd Desktop
```

2. 続けて以下を入力してEnter

```
git clone https://github.com/makoto-job/sendai-rds-handover.git
```

3. ユーザー名を聞かれたら → `makoto-job` と入力
4. パスワードを聞かれたら → GitHubのトークン（ghp_で始まる文字列）を貼り付け

### 成功したらこう表示される

```
Cloning into 'sendai-rds-handover'...
remote: Enumerating objects: ...
Receiving objects: 100% ...
```

---

## ステップ5：ダウンロードできたか確認する

```
cd sendai-rds-handover
```

```
dir
```

ファイルの一覧が表示されたら成功！

---

## これで準備完了！

デスクトップに「sendai-rds-handover」フォルダができています。
中の `index.html` をダブルクリックすればアプリが開きます。

次は「Surfaceで開発する手順書.md」を見ながら作業してください。

---

## うまくいかないとき

| こうなったら | こうする |
|------------|---------|
| `git` が見つからないと言われる | ステップ1のインストールをやり直す |
| パスワードが通らない | GitHubでトークンを作り直す |
| 「already exists」と出る | 既にダウンロード済み。`cd Desktop\sendai-rds-handover` で移動すればOK |
| よくわからないエラー | エラーメッセージをコピーしてClaudeに聞く |
