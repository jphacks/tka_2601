import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavBar, Screen } from '../../components/Screen';
import { Card, GroupHeader, LinkRow, Separator } from '../../components/ui';
import { listMembers } from '../../lib/api';
import { useAuth, useHousehold } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import type { Member } from '../../lib/types';
import { colors } from '../../theme';

function initial(member: Member): string {
  const source = member.full_name?.trim() || member.email || '?';
  return Array.from(source)[0] ?? '?';
}

export default function GroupScreen() {
  const household = useHousehold();
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      listMembers()
        .then((rows) => {
          setMembers(rows);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e) ?? '読み込めませんでした'));
    }, []),
  );

  return (
    <Screen>
      <NavBar title="グループ" backLabel="設定" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <View style={styles.header}>
          <Text style={styles.name} accessibilityRole="header">
            {household.name}
          </Text>
          {members ? <Text style={styles.count}>{`メンバー ${members.length}人`}</Text> : null}
        </View>

        <GroupHeader title="メンバー" first />
        <Card>
          {members ? (
            members.map((member, index) => (
              <Fragment key={member.user_id}>
                {index > 0 ? <Separator inset={68} /> : null}
                <View style={styles.member}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initial(member)}</Text>
                  </View>
                  <View style={styles.memberText}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {`${member.full_name?.trim() || member.email || ''}${member.user_id === session?.user.id ? '（あなた）' : ''}`}
                    </Text>
                    {member.full_name && member.email ? (
                      <Text style={styles.memberEmail} numberOfLines={1}>
                        {member.email}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Fragment>
            ))
          ) : (
            <View style={styles.member}>
              {error ? <Text style={styles.muted}>{error}</Text> : <ActivityIndicator color={colors.navy} />}
            </View>
          )}
        </Card>

        <Card style={styles.inviteCard}>
          <LinkRow label="家族を招待する" labelColor={colors.navy} onPress={() => router.push('/settings/invite')} />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 20, paddingHorizontal: 20, paddingBottom: 4, gap: 4 },
  name: { fontSize: 28, fontWeight: '700', color: colors.text },
  count: { fontSize: 15, color: colors.textSecondary },
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, minHeight: 60 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.navyTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 17, fontWeight: '700', color: colors.navy },
  memberText: { flex: 1, minWidth: 0, gap: 1 },
  memberName: { fontSize: 17, color: colors.text },
  memberEmail: { fontSize: 13, color: colors.textSecondary },
  muted: { fontSize: 15, color: colors.textSecondary },
  inviteCard: { marginTop: 24 },
});
