import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QrCode } from '../../components/QrCode';
import { NavBar, Screen } from '../../components/Screen';
import { PrimaryButton } from '../../components/ui';
import { inviteLink } from '../../lib/app';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { colors, radius } from '../../theme';

export default function InviteScreen() {
  const insets = useSafeAreaInsets();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    repositories.groups
      .getOrCreateInviteToken()
      .then((token) => setLink(inviteLink(token)))
      .catch((e) => setError(errorMessage(e) ?? '招待を作れませんでした'));
  }, []);

  async function share() {
    if (!link) return;
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(link);
        Alert.alert('招待リンクをコピーしました');
        return;
      }
      await Share.share({ message: link });
    } catch (e) {
      Alert.alert('送れませんでした', errorMessage(e) ?? '');
    }
  }

  return (
    <Screen>
      <NavBar title="メンバーを招待" backLabel="グループ" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <View style={[styles.section, styles.qrSection]}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            QR コードを読み取ってもらう
          </Text>
          <View style={styles.qrFrame} accessible accessibilityRole="image" accessibilityLabel="招待用の QR コード">
            {link ? (
              <QrCode value={link} size={200} />
            ) : (
              <View style={styles.qrPlaceholder}>
                {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.navy} />}
              </View>
            )}
          </View>
        </View>

        <View style={[styles.section, styles.linkSection]}>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            離れているメンバーには
          </Text>
          <PrimaryButton label={Platform.OS === 'web' ? '招待リンクをコピーする' : '招待リンクを送る'} disabled={!link} onPress={share} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 16,
    marginHorizontal: 16,
    backgroundColor: colors.card,
    borderRadius: radius.section,
  },
  qrSection: { paddingVertical: 24, paddingHorizontal: 20, alignItems: 'center', gap: 16 },
  linkSection: { padding: 20, gap: 12 },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  qrFrame: {
    padding: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: radius.card,
  },
  qrPlaceholder: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  error: { fontSize: 15, lineHeight: 22, color: colors.textSecondary, textAlign: 'center' },
});
