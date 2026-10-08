// REQ-063: real local memo growth; no storage or Server writes.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Pressable } from '@/components/haptic-pressable';
import { ThemedText } from '@/components/themed-text';
import { tagGrowthRecords } from "@/components/tag-growth-rules";
import type { Memo } from "@/types/memo";
import { useTheme } from '@/hooks/use-theme';

type Period = '日' | '周' | '月';
const rangeLabels = { 日: '近7日', 周: '近4周', 月: '近3个月' };
const GrowingPath = Animated.createAnimatedComponent(Path);
const GrowingRect = Animated.createAnimatedComponent(Rect);
const GrowingCircle = Animated.createAnimatedComponent(Circle);

function GrowthMenuSelection({ selected, color }: { selected: boolean; color: string }) {
  return <Svg width={16} height={16} viewBox="0 0 16 16" accessible={false}>{selected && <Path d="M3 8 L6.5 11.5 L13 4.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />}</Svg>;
}

function GrowthCount({ total, progress }: { total: number; progress: Animated.Value }) {
  const { fontScale } = useWindowDimensions();
  const digitHeight = 30 * fontScale;
  const digits = String(total).split('');
  return <View style={styles.countReels} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {digits.map((digit, index) => {
      const placesFromRight = digits.length - index - 1;
      // Higher places settle first; only the units reel completes a full turn.
      const steps = Number(digit) + (placesFromRight === 0 && total > 0 ? 10 : 0);
      const settleAt = placesFromRight === 0 ? 1 : placesFromRight === 1 ? 0.78 : 0.58;
      return <View key={placesFromRight} style={[styles.countViewport, { width: 14 * fontScale, height: digitHeight }]}>
        <Animated.View style={{ transform: [{ translateY: progress.interpolate({ inputRange: [0, settleAt], outputRange: [0, -steps * digitHeight], extrapolate: 'clamp' }) }] }}>
          {Array.from({ length: steps + 1 }, (_, position) => <ThemedText key={position} style={[styles.total, styles.countDigit, { height: digitHeight }]} themeColor="growthTotalText">{position % 10}</ThemedText>)}
        </Animated.View>
      </View>;
    })}
  </View>;
}

export function TagGrowthCurve({ visible, memos }: { visible: boolean; memos: Memo[] }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const [selectedPeriod, setPeriod] = useState<Period>('日');
  const [selectedTagName, setSelectedTagName] = useState<string | null>(null);
  const [choosingTag, setChoosingTag] = useState(false);
  const [choosingPeriod, setChoosingPeriod] = useState(false);
  const summaryRef = useRef<View>(null);
  const rangeRef = useRef<View>(null);
  const [menuAnchor, setMenuAnchor] = useState({ left: 0, top: 0, width: 0 });
  const [previousVisible, setPreviousVisible] = useState(visible);
  if (previousVisible !== visible) {
    setPreviousVisible(visible);
    if (!visible) { setChoosingTag(false); setChoosingPeriod(false); }
  }
  const [referenceDate, setReferenceDate] = useState(() => new Date());
  const today = visible ? new Date() : referenceDate;
  const [growth] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setReferenceDate(new Date());
      if (state !== 'active' || visible) {
        growth.stopAnimation();
        growth.setValue(1);
      }
    });
    return () => subscription.remove();
  }, [growth, visible]);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (active) setReduceMotion(enabled); }).catch(() => { if (active) setReduceMotion(true); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  const { recordedDays, tagNames, tagTotals } = tagGrowthRecords(memos, today);
  if (selectedTagName !== null && !tagNames.slice(1).includes(selectedTagName)) setSelectedTagName(null);
  const selectedTag = selectedTagName === null ? 0 : Math.max(0, tagNames.slice(1).indexOf(selectedTagName) + 1);
  const dates = recordedDays.map((entry) => ({ date: entry.date, count: entry.counts[selectedTag] }));
  const lifetimeTotal = dates.reduce((sum, entry) => sum + entry.count, 0);
  const firstRecordedDay = dates.find((entry) => entry.count > 0)?.date;
  const recordedDayCount = firstRecordedDay ? Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(firstRecordedDay.getFullYear(), firstRecordedDay.getMonth(), firstRecordedDay.getDate())) / 86400000) + 1 : 0;
  const availablePeriods: Period[] = ['日'];
  if (lifetimeTotal >= 10 && recordedDayCount >= 28) availablePeriods.push('周');
  if (lifetimeTotal >= 30 && recordedDayCount >= 90) availablePeriods.push('月');
  const period = availablePeriods.includes(selectedPeriod) ? selectedPeriod : '日';
  const mondayOffset = (today.getDay() + 6) % 7;
  const windowStart = period === '月' ? new Date(today.getFullYear(), today.getMonth() - 2, 1)
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() - (period === '周' ? mondayOffset + 21 : 6));
  const windowEnd = today;
  const endExclusive = new Date(windowEnd.getFullYear(), windowEnd.getMonth(), windowEnd.getDate() + 1);
  const total = dates.filter((entry) => entry.date < endExclusive).reduce((sum, entry) => sum + entry.count, 0);
  const sampleCount = Math.round((Date.UTC(windowEnd.getFullYear(), windowEnd.getMonth(), windowEnd.getDate()) - Date.UTC(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate())) / 86400000) + 1;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const start = new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate() + index);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { label: `${start.getMonth() + 1}/${start.getDate()}`,
      total: dates.filter((entry) => entry.date < end).reduce((sum, entry) => sum + entry.count, 0),
      added: dates.filter((entry) => entry.date >= start && entry.date < end).reduce((sum, entry) => sum + entry.count, 0) };
  });
  const added = samples.reduce((sum, sample) => sum + sample.added, 0);
  const baseline = samples[0].total - samples[0].added;
  const minimum = Math.max(0, baseline - Math.ceil(Math.max(5, (total - baseline) * 0.1)));
  const points = [baseline, ...samples.map((sample) => sample.total)].map((count, index) => ({ x: 28 + index / samples.length * 208, y: 120 - (count - minimum) / Math.max(1, total - minimum) * 100 }));
  const curve = points.map((point, index) => index === 0 ? `M${point.x},${point.y}` : `H${point.x}V${point.y}`).join(' ');
  const curveLength = points.slice(1).reduce((length, point, index) => length + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0);
  useEffect(() => {
    growth.stopAnimation();
    growth.setValue(visible && reduceMotion ? 1 : 0);
    if (visible && !reduceMotion) Animated.timing(growth, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => growth.stopAnimation();
  }, [growth, visible, reduceMotion, selectedTag, period, total]);
  return (
    <View style={styles.section}>
      <View ref={summaryRef} collapsable={false} style={styles.summary}>
      <Pressable style={({ pressed }) => [styles.selector, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`当前${tagNames[selectedTag]}，选择标签`} accessibilityState={{ expanded: choosingTag }} onPress={() => {
        summaryRef.current?.measureInWindow((left, top, width, height) => {
          setMenuAnchor({ left, top: top + height + 4, width });
          setChoosingTag(true);
        });
      }}>
        <ThemedText numberOfLines={1} style={[styles.headerTag, styles.choiceName]}>{tagNames[selectedTag]}</ThemedText>
        <Svg width={14} height={14} viewBox="0 0 14 14" accessible={false}><Path d={choosingTag ? 'M3 9 L7 5 L11 9' : 'M3 5 L7 9 L11 5'} fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
      </Pressable>
      </View>
      <View ref={rangeRef} collapsable={false} style={styles.rangeRow}>
        <View style={styles.totalGroup} accessible accessibilityLabel={`${total}条积累`}>
          <GrowthCount total={total} progress={growth} />
          <ThemedText style={[styles.unit, { marginBottom: 3 * fontScale }]} themeColor="textSecondary">条积累</ThemedText>
        </View>
        <Pressable disabled={availablePeriods.length === 1} style={({ pressed }) => [styles.rangeSelector, pressed && styles.pressed]} accessibilityRole={availablePeriods.length > 1 ? 'button' : 'text'} accessibilityLabel={`${rangeLabels[period]}新增${added}条${availablePeriods.length > 1 ? '，选择时间范围' : ''}`} accessibilityState={{ expanded: choosingPeriod, disabled: availablePeriods.length === 1 }} onPress={() => {
          rangeRef.current?.measureInWindow((left, top, width, height) => {
            setMenuAnchor({ left, top: top + height + 4, width }); setChoosingPeriod(true);
          });
        }}>
          <View style={styles.rangeAmount}>
            <ThemedText style={styles.added} themeColor="textSecondary">{rangeLabels[period]}</ThemedText>
            <ThemedText style={styles.increase} themeColor={added > 0 ? 'recordingGrowthIncrease' : 'textSecondary'}>+{added}</ThemedText>
          </View>
          {availablePeriods.length > 1 && <Svg width={14} height={14} viewBox="0 0 14 14" accessible={false}><Path d={choosingPeriod ? 'M3 9 L7 5 L11 9' : 'M3 5 L7 9 L11 5'} fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>}
        </Pressable>
      </View>
      <Modal visible={(choosingTag || choosingPeriod) && visible} transparent statusBarTranslucent animationType="none" onRequestClose={() => { setChoosingTag(false); setChoosingPeriod(false); }}>
        <View style={styles.menuLayer}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="关闭选择菜单" onPress={() => { setChoosingTag(false); setChoosingPeriod(false); }} />
          <View accessibilityViewIsModal style={[styles.tagChoices, { left: menuAnchor.left, top: menuAnchor.top, width: menuAnchor.width, backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
            <ScrollView style={styles.tagScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {choosingPeriod ? availablePeriods.map((choice) => <Pressable key={choice} style={({ pressed }) => [styles.tagChoice, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ selected: choice === period }} onPress={() => { setChoosingPeriod(false); setPeriod(choice); }}>
                <ThemedText style={[styles.selectorText, choice === period && { color: theme.accent }]}>{rangeLabels[choice]}</ThemedText>
                <GrowthMenuSelection selected={choice === period} color={theme.accent} />
              </Pressable>) : tagNames.map((name, index) => <Pressable key={index} style={({ pressed }) => [styles.tagChoice, pressed && styles.pressed]} accessibilityRole="button" accessibilityState={{ selected: index === selectedTag }} onPress={() => {
                setSelectedTagName(index === 0 ? null : tagNames[index]); setChoosingTag(false);
                const firstDay = recordedDays.find((entry) => entry.counts[index] > 0)?.date;
                const span = firstDay ? Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate())) / 86400000) + 1 : 0;
                if ((selectedPeriod === '周' && (tagTotals[index] < 10 || span < 28)) || (selectedPeriod === '月' && (tagTotals[index] < 30 || span < 90))) setPeriod('日');
              }}><ThemedText numberOfLines={1} style={[styles.selectorText, styles.choiceName, index === selectedTag && { color: theme.accent }]}>{name}</ThemedText><View style={styles.choiceDetails}><ThemedText style={styles.caption} themeColor="textSecondary">{tagTotals[index]}</ThemedText><GrowthMenuSelection selected={index === selectedTag} color={theme.accent} /></View></Pressable>)}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Svg width="100%" height={144} viewBox="0 0 240 136" accessibilityLabel={`${rangeLabels[period]}累计生长，从${baseline}条到${total}条，新增${added}条`} accessible>
        <Defs>
          <LinearGradient id="tagGrowthFill" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={theme.accent} stopOpacity={0.18} /><Stop offset="1" stopColor={theme.accent} stopOpacity={0.01} /></LinearGradient>
          <ClipPath id="tagGrowthClip"><GrowingRect x={28} y={0} width={growth.interpolate({ inputRange: [0, 1], outputRange: [0, 212] })} height={136} /></ClipPath>
        </Defs>
        <Path d="M28,124 H236" stroke={theme.border} strokeWidth={0.7} />
        <SvgText x={0} y={points[0].y + 3} fontSize={9} fill={theme.textSecondary}>{baseline}</SvgText>
        <G clipPath="url(#tagGrowthClip)"><Path d={`${curve} L236,124 L28,124 Z`} fill="url(#tagGrowthFill)" /></G>
        <GrowingPath d={curve} stroke={theme.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeDasharray={`${curveLength} ${curveLength}`} strokeDashoffset={growth.interpolate({ inputRange: [0, 1], outputRange: [curveLength, 0] })} />
        <GrowingCircle cx={236} cy={points.at(-1)!.y} r={3} fill={theme.accent} opacity={growth.interpolate({ inputRange: [0, 0.9, 1], outputRange: [0, 0, 1] })} />
      </Svg>
      <View style={styles.axis}>{[...new Set([0, samples.length - 1])].map((index) => <ThemedText key={index} style={styles.caption} themeColor="textSecondary">{samples[index].label}</ThemedText>)}</View>
    </View>
  );
}
const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  selector: { minHeight: 44, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  headerTag: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  selectorText: { fontSize: 15, lineHeight: 22, fontWeight: '500' },
  menuLayer: { flex: 1 },
  tagChoices: { position: 'absolute', borderRadius: 10, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, elevation: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.18)' },
  tagScroll: { maxHeight: 264 },
  choiceName: { flexShrink: 1 },
  choiceDetails: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tagChoice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  totalGroup: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  total: { fontFamily: Platform.OS === 'android' ? 'sans-serif-condensed' : undefined, fontSize: 24, lineHeight: 30, fontWeight: '700' },
  countReels: { flexDirection: 'row' },
  countViewport: { overflow: 'hidden' },
  countDigit: { textAlign: 'center', includeFontPadding: false },
  unit: { fontSize: 11, lineHeight: 16, fontWeight: '400' },
  added: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  increase: { fontSize: 12, lineHeight: 18, fontWeight: '500', fontVariant: ['tabular-nums'] },
  rangeAmount: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  rangeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
  rangeSelector: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12 },
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 28 },
  pressed: { opacity: 0.65 },
});
