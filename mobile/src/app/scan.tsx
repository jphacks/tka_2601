import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { NavBar, Screen } from '../components/Screen';
import { CenterMessage, PrimaryButton } from '../components/ui';
import { inviteTokenFromUrl } from '../lib/app';

// デザインにない画面。カメラだけを出し、招待の QR コードを読んだら参加の確認へ進む
export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const focused = useIsFocused();
  const scanned = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [permission, requestPermission]);

  function onScanned(data: string) {
    if (scanned.current) return;
    const token = inviteTokenFromUrl(data);
    if (!token) return;
    scanned.current = true;
    router.replace({ pathname: '/join', params: { token } });
  }

  return (
    <Screen>
      <NavBar title="QR コードを読み取る" backLabel="戻る" onBack={() => router.back()} />
      {permission?.granted ? (
        <View style={styles.cameraBox}>
          {focused ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => onScanned(data)}
            />
          ) : null}
        </View>
      ) : permission && !permission.canAskAgain ? (
        <CenterMessage>
          <PrimaryButton
            label="カメラの使用を許可する"
            style={styles.button}
            onPress={() =>
              Alert.alert('カメラが使えません', '設定アプリで、このアプリのカメラの使用を許可してください。')
            }
          />
        </CenterMessage>
      ) : (
        <CenterMessage>{''}</CenterMessage>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cameraBox: { flex: 1, backgroundColor: '#000000' },
  button: { alignSelf: 'stretch', paddingHorizontal: 24 },
});
