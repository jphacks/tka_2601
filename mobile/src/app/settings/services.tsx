import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChevronRight } from '../../components/icons';
import { NavBar, Screen } from '../../components/Screen';
import { Card, CenterMessage, NavTextButton, Separator } from '../../components/ui';
import type { ShopService } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { minutesLabel, yen } from '../../lib/format';
import { colors } from '../../theme';

export default function ServicesScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [services, setServices] = useState<ShopService[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      repositories.shop
        .listServices(household.id)
        .then((rows) => {
          setServices(rows);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e) ?? '読み込めませんでした'));
    }, [household.id]),
  );

  return (
    <Screen>
      <NavBar
        title="メニュー"
        backLabel="設定"
        onBack={() => router.back()}
        right={
          <NavTextButton
            label="追加"
            accessibilityLabel="メニューを追加"
            onPress={() =>
              router.push({ pathname: '/settings/service', params: { order: String(services?.length ?? 0) } })
            }
          />
        }
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {error ? (
          <View style={styles.message}>
            <CenterMessage>{error}</CenterMessage>
          </View>
        ) : services === null ? (
          <View style={styles.message}>
            <ActivityIndicator color={colors.navy} />
          </View>
        ) : services.length > 0 ? (
          <Card>
            {services.map((service, index) => {
              const meta = [
                minutesLabel(service.duration_minutes),
                service.price_yen !== null ? yen(service.price_yen) : null,
              ]
                .filter(Boolean)
                .join('・');
              return (
                <Fragment key={service.id}>
                  {index > 0 ? <Separator /> : null}
                  <Pressable
                    onPress={() => router.push({ pathname: '/settings/service', params: { id: service.id } })}
                    accessibilityRole="button"
                    accessibilityLabel={`${service.name}、${meta}`}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <View style={styles.body}>
                      <Text style={styles.name} numberOfLines={1}>
                        {service.name}
                      </Text>
                      <Text style={styles.meta}>{meta}</Text>
                    </View>
                    <ChevronRight />
                  </Pressable>
                </Fragment>
              );
            })}
          </Card>
        ) : (
          <View style={styles.message}>
            <CenterMessage>メニューはありません</CenterMessage>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 16 },
  message: { minHeight: 160 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 64, paddingVertical: 8, paddingLeft: 16, paddingRight: 12 },
  pressed: { backgroundColor: colors.separator },
  body: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  meta: { fontSize: 15, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
});
