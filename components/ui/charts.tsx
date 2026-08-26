/**
 * The two charts this app needs.
 *
 * DonutGauge  — one ratio, shown as an arc. Replaces "68%" as plain text.
 * Sparkline   — a run of values, shown as a trend with a fading area fill.
 *
 * Both are SVG and both take their colours from `colors.chart` so a palette
 * change reaches them. Charts are the one place a gradient still earns its
 * keep — ordinary surfaces in this palette are flat. Neither animates its path: morphing an SVG path
 * per frame is the expensive kind of animation, and the count-up beside them
 * already carries the motion.
 */
import React, { useId } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';

import { colors } from '../../constants/theme';

export function DonutGauge({
  /** 0–1. Values outside are clamped. */
  value,
  size = 92,
  thickness = 9,
  colorStops = colors.chart.accent,
  children,
}: {
  value: number;
  size?: number;
  thickness?: number;
  colorStops?: readonly [string, string, ...string[]];
  children?: React.ReactNode;
}) {
  const id = useId();
  const clamped = Math.max(0, Math.min(1, value));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <SvgGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colorStops[0]} />
            <Stop offset="1" stopColor={colorStops[1]} />
          </SvgGradient>
        </Defs>
        {/* Track. `border` rather than `surfaceAlt`, which is the same value
            as the app background and all but disappears on a white card. */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.border}
          strokeWidth={thickness}
          fill="none"
        />
        {/* Value arc, rotated so it starts at 12 o'clock instead of 3 */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={`url(#g${id})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${c * clamped} ${c}`}
          fill="none"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

export function Sparkline({
  values,
  width = 120,
  height = 40,
  positive = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  positive?: boolean;
}) {
  const id = useId();
  // Two points is the minimum that describes a direction.
  if (values.length < 2) return <View style={{ width, height }} />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; give it a mid-height straight line.
  const span = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * height;
    return { x, y };
  });

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const stops = positive ? colors.chart.positive : colors.chart.negative;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <SvgGradient id={`line${id}`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={stops[0]} />
          <Stop offset="1" stopColor={stops[1]} />
        </SvgGradient>
        <SvgGradient id={`fill${id}`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={stops[0]} stopOpacity="0.28" />
          <Stop offset="1" stopColor={stops[0]} stopOpacity="0" />
        </SvgGradient>
      </Defs>
      <Path d={area} fill={`url(#fill${id})`} />
      <Path
        d={line}
        stroke={`url(#line${id})`}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
