// クラウドに設定がない機能は画面に出さない。設定を済ませたら EAS の環境変数で 1 にする（README）
export const features = {
  // 自然言語の入力。Edge Function「assistant」から Ollama に届く必要がある
  assistant: process.env.EXPO_PUBLIC_FEATURE_ASSISTANT === '1',
  // Google カレンダーと Square。OAuth のシークレットが要る
  externalProviders: process.env.EXPO_PUBLIC_FEATURE_EXTERNAL_PROVIDERS === '1',
  // Apple と Google のログイン。Apple は削除時のトークンの失効も要る
  socialLogin: process.env.EXPO_PUBLIC_FEATURE_SOCIAL_LOGIN === '1',
};
