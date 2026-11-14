import AsyncStorage from '@react-native-async-storage/async-storage';

import { onboardingSkipKey } from '../domain/chime';

// 「あとで」を押したお店。起動のたびに案内を出さないよう、端末に覚える。本体が登録されたら消す。
// 読み書きに失敗しても、案内は押さなかったことにして先へ進める（アプリは本体なしでも使える）
export async function readOnboardingSkipped(householdId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(onboardingSkipKey(householdId))) === '1';
  } catch {
    return false;
  }
}

export async function writeOnboardingSkipped(householdId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(onboardingSkipKey(householdId), '1');
  } catch {
    // 覚えられなくても、この起動のあいだは案内に戻らない
  }
}

export async function clearOnboardingSkipped(householdId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(onboardingSkipKey(householdId));
  } catch {
    // 次の起動で本体があれば、案内は出ない
  }
}
