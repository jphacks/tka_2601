"""Public home, privacy policy and terms pages.

Google's OAuth consent screen links to these pages, so they must be public (no API key)
and served from an authorized domain. They are static HTML with no scripts.
"""

from __future__ import annotations

from html import escape

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(include_in_schema=False)

APP_NAME = "Monban"
CONTACT_EMAIL = "shionfilms@gmail.com"
UPDATED = "2026年11月14日"

_HEADERS = {
    "Cache-Control": "public, max-age=3600",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}

_STYLE = """
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --line: #30363d; --link: #4493f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.8 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
h1 { font-size: 1.75rem; line-height: 1.4; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 32px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
p, li { overflow-wrap: anywhere; }
.muted { color: var(--muted); font-size: .9rem; }
a { color: var(--link); }
nav { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); font-size: .9rem; }
nav a { margin-right: 16px; }
"""


def _page(title: str, body: str) -> HTMLResponse:
    html = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<style>{_STYLE}</style>
</head>
<body>
<main>
{body}
<nav><a href="/about">{APP_NAME}について</a><a href="/privacy">プライバシーポリシー</a><a href="/terms">利用規約</a></nav>
</main>
</body>
</html>
"""
    return HTMLResponse(html, headers=_HEADERS)


_CONTACT = f'<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>'


@router.get("/about")
async def about() -> HTMLResponse:
    return _page(
        f"{APP_NAME} — 玄関と店舗受付のAI応対",
        f"""<h1>{APP_NAME}</h1>
<p class="muted">玄関と店舗受付のAI応対</p>
<p>{APP_NAME}は、インターホン端末で来訪者とAIが日本語で会話するサービスです。家庭では宅配や訪問販売への応対を、店舗では予約のお客様の来店受付を代わりに行います。</p>
<h2>主な機能</h2>
<ul>
<li>来訪者との音声会話（宅配の置き場所の案内、訪問販売へのお断りなど）</li>
<li>店舗の予約の確認と来店受付。Googleカレンダーの予定を予約として読み込み、アプリで受けた予約を書き込めます</li>
<li>来客の記録とスマートフォンへの通知</li>
</ul>
<h2>お問い合わせ</h2>
<p>{_CONTACT}</p>""",
    )


@router.get("/privacy")
async def privacy() -> HTMLResponse:
    return _page(
        f"プライバシーポリシー — {APP_NAME}",
        f"""<h1>プライバシーポリシー</h1>
<p class="muted">最終更新日: {UPDATED}</p>
<p>{APP_NAME}（以下「本サービス」）は、利用者と来訪者の情報を次のとおり取り扱います。</p>

<h2>1. 取得する情報</h2>
<ul>
<li><strong>アカウント情報</strong>: メールアドレス、表示名、ログインに使う外部アカウントの識別子</li>
<li><strong>家・店舗の設定</strong>: 店名、営業時間、メニュー、応対の設定、AIへの追加の指示</li>
<li><strong>予約</strong>: お客様の氏名、電話番号、メニュー、日時、来店の記録</li>
<li><strong>来客の記録</strong>: 来訪の日時、用件の分類、会話の文字起こし（文字のみ。音声と画像は保存しません）</li>
<li><strong>通知用の情報</strong>: スマートフォンの通知トークン</li>
<li><strong>Googleアカウントの情報</strong>: 次の章のとおり</li>
</ul>

<h2>2. Googleユーザーデータの取り扱い</h2>
<p>店舗の利用者がGoogleカレンダーとの連携を許可した場合に限り、次の権限を使います。</p>
<ul>
<li><code>calendar.calendarlist.readonly</code>: 連携するカレンダーを選んでいただくため、カレンダーの一覧を読み取ります。</li>
<li><code>calendar.events</code>: 選んだカレンダーの予定を予約として読み込み、本サービスで受けた予約の作成・変更・取り消しを同じカレンダーに書き込みます。</li>
<li><code>openid</code>、<code>email</code>: 連携したGoogleアカウントのメールアドレスを、連携先の表示に使います。</li>
</ul>
<p>Googleの更新トークンは暗号化して保存し、上記の目的にだけ使います。Googleユーザーデータを広告に使うこと、第三者に販売すること、人が閲覧することはありません（法令上必要な場合と、利用者の同意を得て不具合を調べる場合を除きます）。AIモデルの学習にも使いません。</p>
<p>本サービスによるGoogle APIから受け取った情報の使用と他のアプリへの転送は、<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API サービスのユーザーデータに関するポリシー</a>（限定使用の要件を含む）に従います。</p>
<p>連携はアプリからいつでも解除できます。解除すると、Google側の許可を取り消し、保存した更新トークンを削除します。<a href="https://myaccount.google.com/permissions">Googleアカウントの設定</a>からも取り消せます。</p>

<h2>3. 利用目的</h2>
<ul>
<li>来訪者への応対、予約の照合と来店受付</li>
<li>利用者への通知と、来客・予約の記録の表示</li>
<li>本サービスの提供、不正利用の防止、障害の調査</li>
</ul>

<h2>4. 保存場所と委託先</h2>
<p>情報は、データベースと認証の提供元であるSupabaseに保存します。音声の認識・合成とAIの応答の生成は、本サービスが管理する推論サーバーで行い、会話の音声は処理後に保存しません。通知の送信にはExpoの通知サービスを使います。これらの委託先には、サービスの提供に必要な範囲でのみ情報を渡します。</p>

<h2>5. 第三者への提供</h2>
<p>法令に基づく場合を除き、本人の同意なく第三者に提供しません。</p>

<h2>6. 保存期間と削除</h2>
<p>情報は、利用者がアカウントや記録を削除するまで、またはサービスの終了まで保存します。来客の記録はアプリから1件ずつ削除できます。アカウントの削除やデータの開示・訂正・削除のご依頼は、下記までご連絡ください。</p>

<h2>7. 安全管理</h2>
<p>通信は暗号化し、データベースは利用者ごとにアクセスを制限しています。Googleの更新トークンは暗号化して保存します。</p>

<h2>8. 改定</h2>
<p>本ポリシーを変更した場合は、このページで最終更新日とともにお知らせします。</p>

<h2>9. お問い合わせ</h2>
<p>{_CONTACT}</p>""",
    )


@router.get("/terms")
async def terms() -> HTMLResponse:
    return _page(
        f"利用規約 — {APP_NAME}",
        f"""<h1>利用規約</h1>
<p class="muted">最終更新日: {UPDATED}</p>
<p>この規約は、{APP_NAME}（以下「本サービス」）の利用条件を定めるものです。本サービスを利用した時点で、この規約に同意したものとみなします。</p>

<h2>1. サービスの内容</h2>
<p>本サービスは、インターホン端末を通じてAIが来訪者と会話し、家庭や店舗の応対を補助するものです。本サービスは試験提供であり、内容は予告なく変更・中断・終了することがあります。</p>

<h2>2. AIによる応対について</h2>
<p>AIの応答は、誤り、聞き間違い、不適切な表現を含むことがあります。重要な判断（来訪者の本人確認、緊急時の対応、契約や支払いなど）は、利用者ご自身で行ってください。本サービスは鍵、宅配ボックス、カメラなどの機器を操作しません。</p>

<h2>3. 利用者の責任</h2>
<ul>
<li>アカウントと端末の鍵を適切に管理してください。</li>
<li>来訪者に対し、AIが応対していることと、会話が文字として記録されることを、必要に応じて店頭などで知らせてください。</li>
<li>予約のお客様の情報など、第三者の情報を登録する場合は、適法に取得したものに限ってください。</li>
</ul>

<h2>4. 禁止事項</h2>
<ul>
<li>法令または公序良俗に反する利用</li>
<li>本サービスや他の利用者への不正アクセス、妨害</li>
<li>本サービスを他人になりすまして利用すること</li>
</ul>

<h2>5. 免責</h2>
<p>本サービスの利用によって生じた損害について、運営者の故意または重大な過失による場合を除き、責任を負いません。</p>

<h2>6. 規約の変更</h2>
<p>この規約を変更した場合は、このページで最終更新日とともにお知らせします。</p>

<h2>7. お問い合わせ</h2>
<p>{_CONTACT}</p>""",
    )
