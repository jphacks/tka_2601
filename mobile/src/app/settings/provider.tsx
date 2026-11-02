import * as Linking from 'expo-linking';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, CenterMessage, GroupHeader, InfoRow, PrimaryButton, RadioRow, Separator, TextButton } from '../../components/ui';
import type { GoogleCalendar, ProviderState, ReservationProvider } from '../../domain/reservation';
import { confirmAction } from '../../lib/confirm';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { PROVIDER_LABELS, PROVIDER_ORDER } from '../../lib/labels';
import { colors } from '../../theme';

const RETURN_PATH = 'settings/provider';

type Connectable = 'google_calendar' | 'square';

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

function isConnectable(provider: ReservationProvider | undefined): provider is Connectable {
  return provider === 'google_calendar' || provider === 'square';
}

export default function ProviderScreen() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<ProviderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ログインが済んでいない予約先を選んだあいだは、画面の上でだけ選択中にする
  const [selecting, setSelecting] = useState<ReservationProvider | null>(null);
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
    // ログインが切れているとカレンダーは読めないが、予約先の選択とログインし直しはできるようにする
    setCalendarsError(null);
    try {
      setCalendars(next.google.connected ? await repositories.providers.listGoogleCalendars() : null);
    } catch (e) {
      setCalendars(null);
      setCalendarsError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function choose(provider: ReservationProvider) {
    if (!state || busy) return;
    const notReady =
      (provider === 'google_calendar' && !state.google.calendar_id) || (provider === 'square' && !state.square.connected);
    if (notReady) {
      setSelecting(provider);
      return;
    }
    setSelecting(null);
    setBusy(true);
    try {
      setState(await repositories.providers.select(provider));
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
      const returnUrl = Linking.createURL(RETURN_PATH);
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
      // Square はカレンダーを選ばないので、ログインが済んだら予約先も切り替える
      if (kind === 'square') {
        await repositories.providers.select('square');
        setSelecting(null);
      }
      await load();
    } catch (e) {
      Alert.alert('ログインできませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  // カレンダーを選んだら予約先も Google に切り替える
  async function chooseCalendar(calendarId: string) {
    setBusy(true);
    try {
      await repositories.providers.selectGoogleCalendar(calendarId);
      setState(await repositories.providers.select('google_calendar'));
      setSelecting(null);
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
      setSelecting(null);
      await load();
    } catch (e) {
      Alert.alert('ログアウトできませんでした', errorMessage(e) ?? '');
    } finally {
      setBusy(false);
    }
  }

  function connectionOf(provider: Connectable) {
    if (!state) return null;
    if (provider === 'google_calendar') {
      return {
        connected: state.google.connected,
        status: state.google.status,
        lastError: state.google.last_error,
        account: state.google.account_email,
      };
    }
    return {
      connected: state.square.connected,
      status: state.square.status,
      lastError: state.square.last_error,
      account: state.square.merchant_name,
    };
  }

  const selected = selecting ?? state?.provider;
  const kind = isConnectable(selected) ? selected : null;
  const connection = kind ? connectionOf(kind) : null;
  const failed = connection?.status === 'error';
  const google = state?.google;

  return (
    <Screen>
      <NavBar title="予約先" backLabel="設定" onBack={() => router.back()} />
      {!state ? (
        <CenterMessage>{error ?? <ActivityIndicator color={colors.navy} />}</CenterMessage>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
          <GroupHeader title="予約先" first />
          <Card>
            {PROVIDER_ORDER.map((provider, index) => (
              <Fragment key={provider}>
                {index > 0 ? <Separator /> : null}
                <RadioRow
                  label={PROVIDER_LABELS[provider]}
                  value={isConnectable(provider) && connectionOf(provider)?.connected ? 'ログイン済み' : undefined}
                  selected={selected === provider}
                  onPress={() => choose(provider)}
                />
              </Fragment>
            ))}
          </Card>

          {kind && connection ? (
            connection.connected ? (
              <>
                <GroupHeader title={PROVIDER_LABELS[kind]} />
                <Card>
                  {connection.account ? <InfoRow label="アカウント" value={connection.account} /> : null}
                  {connection.account && failed ? <Separator /> : null}
                  {failed ? <InfoRow label="接続エラー" value={connection.lastError ?? '予約を読めません'} /> : null}
                </Card>
                {kind === 'google_calendar' ? (
                  <>
                    <GroupHeader title="カレンダー" />
                    <Card>
                      {calendars ? (
                        calendars.map((calendar, index) => (
                          <Fragment key={calendar.id}>
                            {index > 0 ? <Separator /> : null}
                            <RadioRow
                              label={calendar.name}
                              selected={google?.calendar_id === calendar.id}
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
                  {failed || (kind === 'google_calendar' && calendarsError) ? (
                    <PrimaryButton label={CONNECTIONS[kind].loginLabel} loading={busy} onPress={() => login(kind)} />
                  ) : null}
                  <TextButton
                    label="ログアウト"
                    disabled={busy}
                    onPress={() =>
                      confirmAction({
                        title: CONNECTIONS[kind].logoutTitle,
                        confirmLabel: 'ログアウト',
                        cancelLabel: '戻る',
                        onConfirm: () => logout(kind),
                      })
                    }
                  />
                </View>
              </>
            ) : (
              <View style={styles.actions}>
                <PrimaryButton label={CONNECTIONS[kind].loginLabel} loading={busy} onPress={() => login(kind)} />
              </View>
            )
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  actions: { marginTop: 16, marginHorizontal: 16, gap: 8 },
});
