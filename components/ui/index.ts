/**
 * Public surface of the UI kit.
 *
 * Every name the old single-file components/ui.tsx exported is re-exported here
 * with the same shape, so the 20 screens importing from '../../components/ui'
 * did not need touching when this became a directory.
 */
export { Screen } from './Screen';
export { Card } from './Card';
export { Button } from './Button';
export { Field } from './Field';
export { Icon, type IconName } from './Icon';
export { AnimatedNumber } from './AnimatedNumber';
export { DonutGauge, Sparkline } from './charts';
export { StatTile, ListRow } from './StatTile';
export { Segmented } from './Segmented';
export { BrandMark } from './BrandMark';
export {
  Badge,
  Banner,
  EmptyState,
  ErrorText,
  Heading,
  Loading,
  SectionHeader,
  Skeleton,
} from './feedback';
