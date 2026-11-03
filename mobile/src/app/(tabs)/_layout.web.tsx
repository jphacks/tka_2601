import { Slot } from 'expo-router';

// Web のナビは WebShell が出す。タブの画面は、そのまま中身だけ出す
export default function TabsLayout() {
  return <Slot />;
}
