# Battle Pass Logger Web

GitHub Pages で公開できる Web Bluetooth 版の Battle Pass Logger です。

## 使い方

1. GitHub のリポジトリ設定で Pages を開きます。
2. Source を `Deploy from a branch` にします。
3. Branch を `main`、Folder を `/docs` にして保存します。
4. 発行された `https://ユーザー名.github.io/リポジトリ名/` を Android Chrome で開きます。
5. Bluetooth をオンにして、アプリの `接続` を押します。

Web Bluetooth は HTTPS または `localhost` でのみ動作します。GitHub Pages は HTTPS なので、そのまま利用できます。

## 初期 UUID

- Service UUID: `55c40000-f8eb-11ec-b939-0242ac120002`
- Notify UUID: `55c4f002-f8eb-11ec-b939-0242ac120002`

接続できない場合は、Python 版で確認した UUID に変更してください。
