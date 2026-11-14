// 受付（ボイスバックエンド）の設定と履歴。Edge Function「door」が中継する
export type ReceptionVisit = {
  created: string;
  status: string;
  name: string;
  staff: string;
  staff_notified: boolean;
  notification_reason: string;
};

// カレンダーを選んでいないときの calendar_id は空文字
export type ReceptionGoogle = {
  configured: boolean;
  calendar_id: string;
};

export type ReceptionCalendar = {
  id: string;
  summary: string;
};

// eligible が false の予定は、受付が来店の照合に使わない
export type ReceptionEvent = {
  start: string | null;
  eligible: boolean;
  name: string;
};
