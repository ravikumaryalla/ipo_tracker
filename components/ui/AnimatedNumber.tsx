/**
 * A number that counts up to its value when it first appears or changes.
 *
 * Driven from JS with requestAnimationFrame rather than through reanimated.
 * Reanimated cannot animate a Text child without the animated-TextInput trick,
 * which drags TextInput's own padding and editing behaviour into what should be
 * a label. One re-rendering Text node for under a second is cheap, and this way
 * the formatter stays an ordinary function — important, because these values go
 * through formatInr and must never render as a raw float mid-flight.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { motion } from '../../constants/theme';

/** Decelerating curve — fast start, settles gently on the final figure. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function AnimatedNumber({
  value,
  format,
  style,
  duration = motion.countUp,
}: {
  value: number;
  format: (n: number) => string;
  style?: TextStyle | TextStyle[];
  duration?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(reduceMotion ? value : 0);
  const frame = useRef<number | null>(null);
  const from = useRef(0);

  useEffect(() => {
    if (reduceMotion) {
      setShown(value);
      return;
    }

    const start = Date.now();
    const origin = from.current;
    const delta = value - origin;

    if (delta === 0) {
      setShown(value);
      return;
    }

    const tick = () => {
      const elapsed = Date.now() - start;
      const t = Math.min(elapsed / duration, 1);
      setShown(origin + delta * easeOutCubic(t));
      if (t < 1) {
        frame.current = requestAnimationFrame(tick);
      } else {
        // Land exactly on the target; easing arithmetic will not.
        setShown(value);
        from.current = value;
      }
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // If we are interrupted, continue from wherever we stopped rather than
      // snapping back to zero on the next change.
      from.current = value;
    };
  }, [value, duration, reduceMotion]);

  return <Text style={style}>{format(shown)}</Text>;
}
