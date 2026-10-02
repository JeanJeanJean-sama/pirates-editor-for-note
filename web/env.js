/* env.js — Web版の設定（db.js より前に読み込む） */
self.PEN_ENV = 'web';
self.PEN_VERSION = '__VERSION__'; // ビルド時に manifest.json のバージョンに置き換え
self.PEN_COLLECTOR = '__COLLECTOR__'; // いまのブックマークレット本体の指紋（古い登録のままか判定する）
self.PEN_DB_NAME = 'pen-web'; // github.io の同じドメインの他ページとぶつからない名前
document.documentElement.classList.add('web');
