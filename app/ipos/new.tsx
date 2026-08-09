/**
 * Manually add an IPO.
 *
 * This exists because the auto-sync depends on undocumented NSE/BSE endpoints
 * that can break without warning. When they do, this screen is what keeps the
 * app usable.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Card, ErrorText, Field, Screen } from '../../components/ui';
import { colors, radius, spacing, type } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { createManualIpo } from '../../lib/db/ipos';

/** Accepts DD-MM-YYYY or YYYY-MM-DD; returns the ISO form Postgres wants. */
function toIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dmy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

export default function NewIpo() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { userId } = useAuth();

  const [symbol, setSymbol] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [segment, setSegment] = useState<'MAINBOARD' | 'SME'>('MAINBOARD');
  const [openDate, setOpenDate] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [allotmentDate, setAllotmentDate] = useState('');
  const [listingDate, setListingDate] = useState('');
  const [bandMin, setBandMin] = useState('');
  const [bandMax, setBandMax] = useState('');
  const [lotSize, setLotSize] = useState('');
  const [registrar, setRegistrar] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error('Not signed in.');
      if (!symbol.trim()) throw new Error('Enter the symbol.');
      if (!companyName.trim()) throw new Error('Enter the company name.');

      const open = toIsoDate(openDate);
      const close = toIsoDate(closeDate);
      if (openDate && !open) throw new Error('Open date should look like 10-08-2026.');
      if (closeDate && !close) throw new Error('Close date should look like 12-08-2026.');
      if (open && close && close < open) throw new Error('The close date is before the open date.');

      return createManualIpo(userId, {
        symbol: symbol.trim().toUpperCase(),
        company_name: companyName.trim(),
        segment,
        open_date: open,
        close_date: close,
        allotment_date: toIsoDate(allotmentDate),
        listing_date: toIsoDate(listingDate),
        price_band_min: bandMin ? Number(bandMin) : null,
        price_band_max: bandMax ? Number(bandMax) : null,
        lot_size: lotSize ? Number(lotSize) : null,
        registrar: registrar.trim() || null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ipos'] });
      router.back();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save this IPO.'),
  });

  return (
    <Screen>
      <ErrorText>{error}</ErrorText>

      <Banner tone="info">
        Only you will see this IPO. Auto-synced entries are shared, so if the sync later picks up
        the same issue you may see both.
      </Banner>

      <Card>
        <Field
          label="Symbol"
          value={symbol}
          onChangeText={setSymbol}
          autoCapitalize="characters"
          placeholder="TESTCO"
        />
        <Field
          label="Company name"
          value={companyName}
          onChangeText={setCompanyName}
          placeholder="Test Company Limited"
        />

        <Text style={styles.label}>Segment</Text>
        <View style={styles.chipRow}>
          {(['MAINBOARD', 'SME'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => setSegment(s)}
              style={[styles.chip, s === segment && styles.chipOn]}
            >
              <Text style={[styles.chipText, s === segment && styles.chipTextOn]}>{s}</Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <Text style={styles.section}>Dates</Text>
        <Field label="Opens" value={openDate} onChangeText={setOpenDate} placeholder="10-08-2026" />
        <Field label="Closes" value={closeDate} onChangeText={setCloseDate} placeholder="12-08-2026" />
        <Field label="Allotment" value={allotmentDate} onChangeText={setAllotmentDate} placeholder="14-08-2026" />
        <Field label="Listing" value={listingDate} onChangeText={setListingDate} placeholder="18-08-2026" />
      </Card>

      <Card>
        <Text style={styles.section}>Issue</Text>
        <Field label="Price band — low" value={bandMin} onChangeText={setBandMin} keyboardType="decimal-pad" />
        <Field label="Price band — high" value={bandMax} onChangeText={setBandMax} keyboardType="decimal-pad" />
        <Field
          label="Lot size"
          value={lotSize}
          onChangeText={setLotSize}
          keyboardType="number-pad"
          hint="Shares per lot. Needed to work out how much an application blocks."
        />
        <Field label="Registrar" value={registrar} onChangeText={setRegistrar} placeholder="Link Intime" />
      </Card>

      <Button title="Save IPO" onPress={() => { setError(null); create.mutate(); }} loading={create.isPending} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: colors.text, marginBottom: spacing.md },
  label: { ...type.label, color: colors.textMuted, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { ...type.label, color: colors.textMuted, fontSize: 13, letterSpacing: 0.2 },
  chipTextOn: { color: colors.accent },
});
