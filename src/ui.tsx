// Componenti grafici della dashboard: schede, anelli, grafici, punto pulsante, comparsa.
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { C } from './theme';
import { tap } from './settings';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// La scheda compare salendo leggermente; `delay` crea l'effetto a cascata
export function Card({ children, delay = 0, style, onPress }: { children: ReactNode; delay?: number; style?: ViewStyle; onPress?: () => void }) {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 420, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [appear, delay]);
  const body = (
    <Animated.View
      style={[
        styles.card,
        style,
        { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] },
      ]}
    >
      {children}
    </Animated.View>
  );
  if (!onPress) return body;
  return <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => pressed && { opacity: 0.85 }}>{body}</Pressable>;
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.titleRow}>
      <Text style={styles.title}>{children}</Text>
      {right}
    </View>
  );
}

// Punto di stato: verde pulsante se online, grigio fermo se no
export function PulseDot({ on, size = 10 }: { on: boolean; size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) { pulse.stopAnimation(); pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [on, pulse]);
  return (
    <View style={{ width: size * 2.4, height: size * 2.4, alignItems: 'center', justifyContent: 'center' }}>
      {on && (
        <Animated.View
          style={{
            position: 'absolute', width: size, height: size, borderRadius: size, backgroundColor: C.accent,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
          }}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: on ? C.accent : C.muted }} />
    </View>
  );
}

// Anello percentuale animato (CPU, GPU, RAM)
export function Ring({ value, label, size = 78, stroke = 8, warnAt = 0.85 }: { value: number | null; label: string; size?: number; stroke?: number; warnAt?: number }) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const anim = useRef(new Animated.Value(0)).current;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  useEffect(() => {
    Animated.timing(anim, { toValue: v, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [v, anim]);
  const color = v >= warnAt ? C.warning : C.accent;
  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.surface2} strokeWidth={stroke} fill="none" />
          <AnimatedCircle
            cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={anim.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] })}
          />
        </Svg>
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={styles.ringValue}>{value == null ? '–' : `${Math.round(v * 100)}%`}</Text>
        </View>
      </View>
      <Text style={styles.ringLabel}>{label}</Text>
    </View>
  );
}

// Grafico a linea con area sfumata (ultimi ~80 secondi)
export function Sparkline({ values, height = 46, color = C.accent }: { values: number[]; height?: number; color?: string }) {
  const width = 300;
  if (values.length < 2) return <View style={{ height }} />;
  const max = 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (Math.max(0, Math.min(max, v)) / max) * (height - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.35" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Path d={area} fill="url(#fill)" />
      <Path d={line} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'accent' | 'muted' | 'warning' }) {
  const color = tone === 'accent' ? C.accent : tone === 'warning' ? C.warning : C.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}

export function ActionButton({ label, icon, onPress, disabled }: { label: string; icon: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => { tap(); onPress(); }}
      style={({ pressed }) => [styles.action, disabled && { opacity: 0.4 }, pressed && { transform: [{ scale: 0.96 }] }]}
    >
      <Text style={styles.actionIcon}>{icon}</Text>
      <Text style={styles.actionText} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  ringValue: { color: C.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ringLabel: { color: C.muted, fontSize: 12 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  action: {
    flex: 1, minHeight: 78, padding: 12, borderRadius: 14, backgroundColor: C.surface2,
    borderWidth: 1, borderColor: C.border, justifyContent: 'space-between',
  },
  actionIcon: { fontSize: 20 },
  actionText: { color: C.text, fontSize: 13, fontWeight: '600' },
});
