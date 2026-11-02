import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { onNotificationReceived } from './notificationEvents';

// 開いている画面を、アプリが前面に戻ったときと通知を受けたときに読み直す
export function useLiveRefresh(refresh: () => void) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      const appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') latest.current();
      });
      const stopReceived = onNotificationReceived(() => latest.current());
      return () => {
        appState.remove();
        stopReceived();
      };
    }, []),
  );
}
