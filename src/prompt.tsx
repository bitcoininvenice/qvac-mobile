// Text prompts and file sharing that work on both iOS and Android.
// - askText(): iOS keeps its native Alert.prompt; Android (which has none) gets a small modal,
//   drawn by <PromptHost /> (mounted once, in App.tsx).
// - shareFile(): iOS share sheet / Android chooser for a file inside the app.
import { useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { C } from './theme';

type Request = { title: string; message?: string; value: string; resolve: (text: string | null) => void };
let show: ((r: Request) => void) | null = null;

// Resolves with the text, or null if cancelled
export function askText(title: string, message?: string, defaultValue = ''): Promise<string | null> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      Alert.prompt(title, message, [
        { text: 'Annulla', style: 'cancel', onPress: () => resolve(null) },
        { text: 'OK', onPress: (text?: string) => resolve(text ?? '') },
      ], 'plain-text', defaultValue);
    });
  }
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ title, message, value: defaultValue, resolve });
  });
}

export function PromptHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    show = (r) => { setText(r.value); setReq(r); };
    return () => { show = null; };
  }, []);
  const close = (value: string | null) => {
    req?.resolve(value);
    setReq(null);
  };
  return (
    <Modal visible={Boolean(req)} transparent animationType="fade" onRequestClose={() => close(null)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{req?.title}</Text>
          {!!req?.message && <Text style={styles.message}>{req.message}</Text>}
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            autoFocus
            selectTextOnFocus
            onSubmitEditing={() => close(text)}
            returnKeyType="done"
            placeholderTextColor={C.muted}
          />
          <View style={styles.row}>
            <Pressable style={styles.button} onPress={() => close(null)}><Text style={styles.cancel}>Annulla</Text></Pressable>
            <Pressable style={styles.button} onPress={() => close(text)}><Text style={styles.ok}>OK</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// A file of the app (file:// uri) to another app, or to save it elsewhere
export async function shareFile(uri: string, mimeType?: string) {
  if (Platform.OS === 'ios') return Share.share({ url: uri });
  if (!(await Sharing.isAvailableAsync())) throw new Error('Condivisione non disponibile su questo dispositivo');
  return Sharing.shareAsync(uri, { mimeType: mimeType || undefined });
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, gap: 10 },
  title: { color: C.text, fontSize: 17, fontWeight: '700' },
  message: { color: C.muted, fontSize: 14, lineHeight: 19 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: C.text, fontSize: 16, backgroundColor: C.bg },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  button: { paddingHorizontal: 14, paddingVertical: 10 },
  cancel: { color: C.muted, fontWeight: '600', fontSize: 15 },
  ok: { color: C.accent, fontWeight: '700', fontSize: 15 },
});
