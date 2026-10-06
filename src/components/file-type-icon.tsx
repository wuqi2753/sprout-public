// REQ-049: one vector file-type icon across saved notes, drafts and editor.
import Svg, { Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/hooks/use-theme';

export function FileTypeIcon({ name, size = 36 }: { name: string; size?: number }) {
  const theme = useTheme();
  const extension = name.split('.').at(-1)?.toLowerCase();
  const spreadsheet = extension === 'xls' || extension === 'xlsx' || extension === 'csv';
  const pdf = extension === 'pdf';
  const color = spreadsheet ? theme.fileSpreadsheet : pdf ? theme.filePdf : theme.textSecondary;
  return <Svg width={size} height={size} viewBox="0 0 40 40" accessible={false}>
    <Path d="M11 3H25L34 12V34A3 3 0 0 1 31 37H11A3 3 0 0 1 8 34V6A3 3 0 0 1 11 3Z" fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    <Path d="M25 3V10A2 2 0 0 0 27 12H34" fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    {spreadsheet ? <>
      <Rect x={14} y={17} width={14} height={13} rx={1.5} fill="none" stroke={color} strokeWidth={1.5} />
      <Path d="M14 21.5H28M14 26H28M19 17V30" stroke={color} strokeWidth={1.3} />
    </> : pdf ? <>
      <Rect x={4} y={20} width={29} height={13} rx={3} fill={color} />
      <SvgText x={18.5} y={29.5} textAnchor="middle" fontSize={9} fontWeight="700" fill={theme.surface}>PDF</SvgText>
    </> : <Path d="M14 20H28M14 25H28M14 30H23" stroke={color} strokeWidth={1.5} strokeLinecap="round" />}
  </Svg>;
}
