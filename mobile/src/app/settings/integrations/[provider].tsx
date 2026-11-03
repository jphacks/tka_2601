import * as Linking from 'expo-linking';
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReceptionGoogleSection } from '../../../components/ReceptionGoogleSection';
import { NavBar, Screen } from '../../../components/Screen';
import {
  Card,
  CenterMessage,
  GroupHeader,
  InfoRow,
  PrimaryButton,
  RadioRow,
  RowSwitch,
  Separator,
  TextButton,
} from '../../../components/ui';
import type { GoogleCalendar, ProviderState } from '../../../domain/reservation';
import { confirmAction } from '../../../lib/confirm';
import { repositories } from '../../../lib/container';
import { errorMessage } from '../../../lib/errors';
import { features } from '../../../lib/features';
import { type Integration, isIntegration } from '../../../lib/integrations';
import { PROVIDER_LABELS } from '../../../lib/labels';
import { colors } from '../../../theme';

type Connectable = Exclude<Integration, 'hotpepper'>;

const CONNECTIONS: Record<
  Connectable,
  {
    loginLabel: string;
    resultParam: string;
    start: (returnUrl: string) => Promise<string>;
    complete: (code: string) => Promise<ProviderState>;
    logout: () => Promise<void>;
    logoutTitle: string;
  }
> = {
  google_calendar: {
    loginLabel: 'Google でログイン',
    resultParam: 'google',
    start: (returnUrl) => repositories.providers.startGoogleLogin(returnUrl),
    complete: (code) => repositories.providers.completeGoogleLogin(code),
    logout: () => repositories.providers.logoutGoogle(),
    logoutTitle: 'Google からログアウトしますか',
  },
  square: {
    loginLabel: 'Square にログイン',
    resultParam: 'square',
    start: (returnUrl) => repositories.providers.startSquareLogin(returnUrl),
    complete: (code) => repositories.providers.completeSquareLogin(code),
    logout: () => repositories.providers.logoutSquare(),
    logoutTitle: 'Square からログアウトしますか',
  },
};

export default function IntegrationRoute() {
  const { provider } = useLocalSearchParams<{ provider?: string }>();
  // 知らない名前の URL（古い通知や手で開いたもの）は設定に戻す
  return isIntegration(provider) ? <IntegrationScreen provider={provider} /> : <Redirect href="/settings" />;
}

function IntegrationScreen({ provider }: { provider: Integration }) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<ProviderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendar[] | null>(null);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    let next: ProviderState;
    try {
      next = await repositories.providers.getState();
      setState(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e) ?? '読み込めませんでした');
      return;
    }
    if (provider !== 'google_calendar') return;
    // ログインが切れているとカレンダーは読めないが、使うかどうかの切り替えとログインし直しはできるようにする
    setCalendarsError(null);
    try {
      setCalendars(next.google.connected ? await repositories.providers.listGoogleCalendars() : null);
    } catch (e) {
      setCalendars(null);
      setCalendarsError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, [provider]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // アプリの予約一覧に出す連携を切り替える。切ると、アプリの予約帳に戻る
  async function setInUse(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      setState(await repositories.providers.select(next ? provider : 'monban'));
    } catch (e) {
      Alert.alert('変更できませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function login(kind: Connectable) {
    const connection = CONNECTIONS[kind];
    setBusy(true);
    try {
      const returnUrl = Linking.createURL(`settings/integrations/${kind}`);
      const url = await connection.start(returnUrl);
      const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
      if (result.type !== 'success') return;
      const query = Linking.parse(result.url).queryParams;
      const outcome = query?.[connection.resultParam];
      if (outcome === 'error') {
        Alert.alert('ログインできませんでした', '');
        return;
      }
      if (outcome !== 'pending' || typeof query?.code !== 'string') return;
      // 同意画面から戻っただけでは接続されない。ログインした本人のセッションで完了させる
      await connection.complete(query.code);
      // Square はカレンダーを選ばないので、つないだら予約一覧にも使う
      if (kind === 'square') await repositories.providers.select('square');
      await load();
    } catch (e) {
      Alert.alert('ログインできませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  // 初めてカレンダーを選んだときは、予約一覧にも使う。選び直すときは、使うかどうかを変えない
  async function chooseCalendar(calendarId: string) {
    if (!state || busy) return;
    const first = !state.google.calendar_id;
    setBusy(true);
    try {
      await repositories.providers.selectGoogleCalendar(calendarId);
      if (first) await repositories.providers.select('google_calendar');
      await load();
    } catch (e) {
      Alert.alert('変更できませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function logout(kind: Connectable) {
    setBusy(true);
    try {
      await CONNECTIONS[kind].logout();
      await load();
    } catch (e) {
      Alert.alert('ログアウトできませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  const connectable: Connectable | null = provider === 'hotpepper' ? null : provider;
  const connection =
    state && connectable
      ? connectable === 'google_calendar'
        ? {
            connected: state.google.connected,
            status: state.google.status,
            lastError: state.google.last_error,
            account: state.google.account_email,
          }
        : {
            connected: state.square.connected,
            status: state.square.status,
            lastError: state.square.last_error,
            account: state.square.merchant_name,
          }
      : null;
  const failed = connection?.status === 'error';
  const inUse = state?.provider === provider;
  // Google はカレンダーを選ぶまで、読む先がない
  const canUse = provider !== 'google_calendar' || !!state?.google.calendar_id;

  const switchRow = (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>予約一覧に使う</Text>
      <RowSwitch
        accessibilityLabel="予約一覧に使う"
        value={inUse}
        disabled={busy || !canUse}
        onValueChange={setInUse}
      />
    </View>
  );

  return (
    <Screen>
      <NavBar title={PROVIDER_LABELS[provider]} backLabel="設定" onBack={() => router.back()} />
      {!state ? (
        <CenterMessage>{error ?? <ActivityIndicator color={colors.navy} />}</CenterMessage>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          <GroupHeader title="予約の表示" first />
          {connectable && connection ? (
            connection.connected ? (
              <>
                <Card>
                  {connection.account ? <InfoRow label="アカウント" value={connection.account} /> : null}
                  {connection.account ? <Separator /> : null}
                  {failed ? <InfoRow label="接続エラー" value={connection.lastError ?? '予約を読めません'} /> : null}
                  {failed ? <Separator /> : null}
                  {switchRow}
                </Card>
                {connectable === 'google_calendar' ? (
                  <>
                    <GroupHeader title="カレンダー" />
                    <Card>
                      {calendars ? (
                        calendars.map((calendar, index) => (
                          <Fragment key={calendar.id}>
                            {index > 0 ? <Separator /> : null}
                            <RadioRow
                              label={calendar.name}
                              selected={state.google.calendar_id === calendar.id}
                              onPress={() => chooseCalendar(calendar.id)}
                            />
                          </Fragment>
                        ))
                      ) : calendarsError ? (
                        <InfoRow label="読み込みエラー" value={calendarsError} />
                      ) : (
                        <View style={styles.loading}>
                          <ActivityIndicator color={colors.navy} />
                        </View>
                      )}
                    </Card>
                  </>
                ) : null}
                <View style={styles.actions}>
                  {failed || (connectable === 'google_calendar' && calendarsError) ? (
                    <PrimaryButton label={CONNECTIONS[connectable].loginLabel} loading={busy} onPress={() => login(connectable)} />
                  ) : null}
                  <TextButton
                    label="ログアウト"
                    disabled={busy}
                    onPress={() =>
                      confirmAction({
                        title: CONNECTIONS[connectable].logoutTitle,
                        confirmLabel: 'ログアウト',
                        cancelLabel: '戻る',
                        onConfirm: () => logout(connectable),
                      })
                    }
                  />
                </View>
              </>
            ) : (
              <>
                <Card>
                  <InfoRow label="状態" value="未接続" />
                </Card>
                <View style={styles.actions}>
                  <PrimaryButton label={CONNECTIONS[connectable].loginLabel} loading={busy} onPress={() => login(connectable)} />
                </View>
              </>
            )
          ) : (
            <Card>{switchRow}</Card>
          )}

          {provider === 'google_calendar' && features.reception ? <ReceptionGoogleSection /> : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  actions: { marginTop: 16, marginHorizontal: 16, gap: 8 },
  switchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  switchLabel: { flex: 1, fontSize: 17, color: colors.text },
});
