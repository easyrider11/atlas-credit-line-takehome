import Slider from '@react-native-community/slider';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ApiClient, ApiResult, JsonObject, Persona, personas } from './src/apiClient';
import { color, radius, space, type } from './src/tokens';

// Experiment groups (see DECISIONS.pdf): two separate splits, by whether the
// member had room under their ceiling at signup.
//   Room:     flow 95%     - the revised request flow
//             holdback 5%  - no increase feature, the control experience
//   No room:  hidden 50%   - A: no entry point, the same Home control saw
//             status 50%   - B: no entry point, plus a card: no increase
//                            available, and why
// The demo GROUP switch offers only the pair that applies to the member shown.
// Assignment itself (randomizing at signup) is not built.
const roomGroups = ['flow', 'holdback'] as const;
const noRoomGroups = ['hidden', 'status'] as const;
type RoomGroup = (typeof roomGroups)[number];
type NoRoomGroup = (typeof noRoomGroups)[number];
const groupLabel: Record<RoomGroup | NoRoomGroup, string> = {
  flow: 'Room · revised flow (95%)',
  holdback: 'Room · holdback, no feature (5%)',
  hidden: 'No room · A hidden (50%)',
  status: 'No room · B status card (50%)',
};

// Bounds of POST /v1/credit-line/increase-requests.
const MIN_ASK_CENTS = 10000;
const MAX_ASK_CENTS = 250000;
const STEP_CENTS = 5000;
// Same starting point in both arms so the amount isn't a second variable.
const DEFAULT_ASK_CENTS = 50000;

// Compliance: a declined member must be told the specific reasons.
const reasonCopy: Record<string, string> = {
  UTILIZATION_TOO_HIGH:
    'Your credit file shows high utilization on this card and / or other cards as of late.',
  INSUFFICIENT_PAYMENT_HISTORY: 'We need to see a longer run of on-time payments first.',
  NEW_CREDIT_LINES: "We've noticed a number of new credit lines you've opened recently.",
};

// The same reasons for a member who never asked. Stated as facts: the decline
// wording ("...first") reads as a path to an increase, and the ceiling is fixed.
const statusReasonCopy: Record<string, string> = {
  UTILIZATION_TOO_HIGH:
    'Your credit file shows high utilization on this card and / or other cards as of late.',
  INSUFFICIENT_PAYMENT_HISTORY: 'Your record of on-time payments with us is still short.',
  NEW_CREDIT_LINES: 'Your credit file shows a number of new credit lines opened recently.',
};

type IncreaseRequest = {
  status: string;
  requestedCents: number;
  approvedCents: number;
  newLimitCents: number;
  reasonCodes: string[];
  createdAt: string | null;
};

type CreditLine = {
  limitCents: number;
  maxEligibleCents: number;
  balanceCents: number;
  holdsCents: number;
  increaseRequest: IncreaseRequest | null;
  // Whether the member had room at signup, and if not, why. Set at signup,
  // like the ceiling, so it decides which experiment split they are in.
  roomAtSignup: boolean;
  noRoomReasons: string[];
};

type Outcome =
  | { kind: 'decided'; request: IncreaseRequest }
  | { kind: 'invalid'; message: string }
  | { kind: 'failed' };

type Screen =
  | { name: 'home'; refreshKey: number }
  | { name: 'request'; line: CreditLine }
  | { name: 'result'; line: CreditLine; outcome: Outcome };

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});
const wholeCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function money(cents: number) {
  return currency.format(cents / 100);
}

function moneyWhole(cents: number) {
  return wholeCurrency.format(cents / 100);
}

function shortDate(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function numberField(object: JsonObject | null, key: string) {
  const value = object?.[key];
  return typeof value === 'number' ? value : 0;
}

function parseIncreaseRequest(value: unknown): IncreaseRequest | null {
  if (value === null || typeof value !== 'object') return null;
  const object = value as JsonObject;
  if (typeof object.status !== 'string') return null;
  return {
    status: object.status,
    requestedCents: numberField(object, 'requested_amount_cents'),
    approvedCents: numberField(object, 'approved_amount_cents'),
    newLimitCents: numberField(object, 'new_limit_cents'),
    reasonCodes: stringList(object.reason_codes),
    createdAt: typeof object.created_at === 'string' ? object.created_at : null,
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseCreditLine(body: JsonObject): CreditLine {
  const eligibility = body.increase_eligibility;
  return {
    limitCents: numberField(body, 'limit_cents'),
    maxEligibleCents: numberField(body, 'max_eligible_limit_cents'),
    balanceCents: numberField(body, 'balance_cents'),
    holdsCents: numberField(body, 'pending_holds_cents'),
    increaseRequest: parseIncreaseRequest(body.increase_request),
    roomAtSignup: eligibility !== null && typeof eligibility === 'object'
      && typeof (eligibility as JsonObject).eligible === 'boolean'
      ? (eligibility as JsonObject).eligible === true
      : numberField(body, 'max_eligible_limit_cents') - numberField(body, 'limit_cents') >= MIN_ASK_CENTS,
    noRoomReasons: eligibility !== null && typeof eligibility === 'object'
      ? stringList((eligibility as JsonObject).reason_codes)
      : [],
  };
}

function availableCents(line: CreditLine, limitCents = line.limitCents) {
  return Math.max(0, limitCents - line.balanceCents - line.holdsCents);
}

// The most this member can add and still land at or under their ceiling,
// clamped to what the endpoint accepts.
function maxAskCents(line: CreditLine) {
  const room = line.maxEligibleCents - line.limitCents;
  return Math.min(MAX_ASK_CENTS, Math.floor(room / STEP_CENTS) * STEP_CENTS);
}

// Never put a member in front of an ask that is doomed: no entry point unless
// even the smallest amount fits under their ceiling.
function canIncrease(line: CreditLine) {
  return line.increaseRequest === null && maxAskCents(line) >= MIN_ASK_CENTS;
}

// Has never asked and never could: the members arms A and B treat differently.
function hasNoRoom(line: CreditLine) {
  return line.increaseRequest === null && maxAskCents(line) < MIN_ASK_CENTS;
}

// Web demo only: ?persona=insufficient-history&group=status opens straight into
// a combination, so reviewers can link to each experiment group.
function demoParam<T extends string>(name: string, options: readonly T[]): T | null {
  const search = typeof window !== 'undefined' ? window.location?.search : undefined;
  if (!search) return null;
  const value = new URLSearchParams(search).get(name);
  return options.find((option) => option === value) ?? null;
}

function toOutcome(result: ApiResult | null): Outcome {
  if (!result || result.statusCode >= 500) return { kind: 'failed' };
  if (result.isSuccess) {
    const request = parseIncreaseRequest(result.body);
    if (request) return { kind: 'decided', request };
  }
  // A retry after a lost response lands here; show the decision that was made.
  if (result.errorCode === 'ALREADY_REQUESTED') {
    const prior = parseIncreaseRequest(result.body.increase_request);
    if (prior) return { kind: 'decided', request: prior };
  }
  if (result.statusCode === 400 || result.statusCode === 422) {
    return {
      kind: 'invalid',
      message: typeof result.body.message === 'string'
        ? result.body.message
        : 'Please choose a different amount.',
    };
  }
  return { kind: 'failed' };
}

export default function App() {
  const api = useMemo(() => {
    const client = new ApiClient();
    client.persona = demoParam('persona', personas) ?? client.persona;
    return client;
  }, []);
  const [roomGroup, setRoomGroup] = useState<RoomGroup>(
    () => demoParam('group', roomGroups) ?? 'flow',
  );
  const [noRoomGroup, setNoRoomGroup] = useState<NoRoomGroup>(
    () => demoParam('group', noRoomGroups) ?? 'hidden',
  );
  const [screen, setScreen] = useState<Screen>({ name: 'home', refreshKey: 0 });

  const goHome = () => {
    setScreen((current) => ({
      name: 'home',
      refreshKey: current.name === 'home' ? current.refreshKey + 1 : Date.now(),
    }));
  };

  // After an ambiguous failure the server may have decided and only the
  // response was lost. Read the account before offering another submit.
  // Resolves false when the account can't be read, so the caller keeps the
  // uncertain state instead of assuming nothing was sent.
  const reconcile = async () => {
    let fresh: CreditLine;
    try {
      const response = await api.getCreditLine();
      if (!response.isSuccess) return false;
      fresh = parseCreditLine(response.body);
    } catch {
      return false;
    }
    if (fresh.increaseRequest) {
      setScreen({
        name: 'result',
        line: fresh,
        outcome: { kind: 'decided', request: fresh.increaseRequest },
      });
    } else if (canIncrease(fresh)) {
      setScreen({ name: 'request', line: fresh });
    } else {
      goHome();
    }
    return true;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {screen.name === 'home' ? (
        <HomePage
          api={api}
          roomGroup={roomGroup}
          noRoomGroup={noRoomGroup}
          onRoomGroupChange={setRoomGroup}
          onNoRoomGroupChange={setNoRoomGroup}
          refreshKey={screen.refreshKey}
          onIncrease={(line) => setScreen({ name: 'request', line })}
        />
      ) : screen.name === 'request' ? (
        <RequestPage
          api={api}
          line={screen.line}
          onBack={goHome}
          onOutcome={(outcome) => setScreen({ name: 'result', line: screen.line, outcome })}
        />
      ) : (
        <ResultPage
          line={screen.line}
          outcome={screen.outcome}
          onRetry={() => setScreen({ name: 'request', line: screen.line })}
          onReconcile={reconcile}
          onDone={goHome}
        />
      )}
    </SafeAreaView>
  );
}

function HomePage({
  api,
  roomGroup,
  noRoomGroup,
  onRoomGroupChange,
  onNoRoomGroupChange,
  refreshKey,
  onIncrease,
}: {
  api: ApiClient;
  roomGroup: RoomGroup;
  noRoomGroup: NoRoomGroup;
  onRoomGroupChange: (group: RoomGroup) => void;
  onNoRoomGroupChange: (group: NoRoomGroup) => void;
  refreshKey: number;
  onIncrease: (line: CreditLine) => void;
}) {
  const [line, setLine] = useState<CreditLine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [persona, setPersona] = useState<Persona>(api.persona);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    api.getCreditLine().then((response) => {
      if (!active) return;
      if (response.isSuccess) {
        setLine(parseCreditLine(response.body));
      } else {
        setError('The API answered HTTP ' + response.statusCode + '.');
      }
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError('Could not reach the mock API.\nIs it running? cd mock-api && npm start');
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [api, persona, refreshKey, reloadKey]);

  const choosePersona = (next: Persona) => {
    api.persona = next;
    setPersona(next);
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={type.title}>Your credit line</Text>
        <View style={styles.topGap} />

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={color.accent} />
          </View>
        ) : error || !line ? (
          <View style={styles.centered}>
            <Text style={[type.bodyMuted, styles.centerText]}>{error}</Text>
            <View style={styles.mediumGap} />
            <SecondaryButton label="Retry" onPress={() => setReloadKey((value) => value + 1)} />
          </View>
        ) : (
          <View style={styles.flex}>
            <View style={styles.card}>
              <Text style={styles.label}>AVAILABLE TO SPEND</Text>
              <View style={styles.tinyGap} />
              <Text style={[type.display, styles.numeric]}>{money(availableCents(line))}</Text>
              <View style={styles.divider} />
              <AccountRow label="Credit limit" value={money(line.limitCents)} />
              <View style={styles.smallGap} />
              <AccountRow label="Balance" value={money(line.balanceCents)} />
              {line.holdsCents > 0 ? (
                <>
                  <View style={styles.smallGap} />
                  <AccountRow label="Pending" value={money(line.holdsCents)} />
                </>
              ) : null}
            </View>

            {line.increaseRequest ? (
              <>
                <View style={styles.mediumGap} />
                <PastRequestCard line={line} request={line.increaseRequest} />
              </>
            ) : null}

            {noRoomGroup === 'status' && hasNoRoom(line) ? (
              <>
                <View style={styles.mediumGap} />
                <LimitStatusCard line={line} />
              </>
            ) : null}

            {roomGroup === 'flow' && canIncrease(line) ? (
              <>
                <View style={styles.largeGap} />
                <PrimaryButton label="Request an increase" onPress={() => onIncrease(line)} />
              </>
            ) : null}
          </View>
        )}

        <View style={styles.largeGap} />
        <View style={styles.demoDivider} />
        <Text style={type.small}>Demo controls · not part of the member's app</Text>
        <DemoPicker
          label="PERSONA"
          value={persona}
          options={personas}
          describe={(option) => option}
          onChange={choosePersona}
        />
        {line && !loading ? (
          line.roomAtSignup ? (
            <DemoPicker
              label="GROUP"
              value={roomGroup}
              options={roomGroups}
              describe={(option) => groupLabel[option]}
              onChange={onRoomGroupChange}
            />
          ) : (
            <DemoPicker
              label="GROUP"
              value={noRoomGroup}
              options={noRoomGroups}
              describe={(option) => groupLabel[option]}
              onChange={onNoRoomGroupChange}
            />
          )
        ) : null}
      </View>
    </ScrollView>
  );
}

// Arm B, members with no room only. States the limit, that no increase is
// available, and the specific reasons; nothing else, so the arm tests the
// explanation alone. No request is made, so there is no soft inquiry.
function LimitStatusCard({ line }: { line: CreditLine }) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>LIMIT INCREASE</Text>
      <View style={styles.smallGap} />
      <Text style={type.heading}>An increase isn't available on your account</Text>
      <View style={styles.tinyGap} />
      <Text style={type.small}>{'Your credit limit is ' + moneyWhole(line.limitCents) + '.'}</Text>
      <View style={styles.mediumGap} />
      <DeclineReasons codes={line.noRoomReasons} copy={statusReasonCopy} />
    </View>
  );
}

// Shown in both arms once a member has asked: they can only ask once, so the
// decision (and, for a decline, the reasons) stays visible instead of the
// button silently disappearing.
function PastRequestCard({ line, request }: { line: CreditLine; request: IncreaseRequest }) {
  const when = shortDate(request.createdAt);
  if (request.status === 'APPROVED') {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>LIMIT INCREASE</Text>
        <View style={styles.smallGap} />
        <Text style={type.body}>
          {'You added ' + moneyWhole(request.approvedCents) + ' to your limit' +
            (when ? ' on ' + when : '') + '.'}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={styles.label}>LIMIT INCREASE REQUEST</Text>
      <View style={styles.smallGap} />
      <Text style={type.body}>
        {'Your request' + (when ? ' on ' + when : '') + " wasn't approved. Your limit stays at " +
          moneyWhole(line.limitCents) + '.'}
      </Text>
      <View style={styles.smallGap} />
      <DeclineReasons codes={request.reasonCodes} />
    </View>
  );
}

function RequestPage({
  api,
  line,
  onBack,
  onOutcome,
}: {
  api: ApiClient;
  line: CreditLine;
  onBack: () => void;
  onOutcome: (outcome: Outcome) => void;
}) {
  const max = maxAskCents(line);
  const [amount, setAmount] = useState(Math.min(DEFAULT_ASK_CENTS, max));
  const [submitting, setSubmitting] = useState(false);
  const newLimit = line.limitCents + amount;

  const nudge = (delta: number) => {
    setAmount((current) => Math.min(max, Math.max(MIN_ASK_CENTS, current + delta)));
  };

  const submit = async () => {
    setSubmitting(true);
    let result: ApiResult | null = null;
    try {
      result = await api.submitIncreaseRequest(amount);
    } catch {
      result = null;
    }
    setSubmitting(false);
    onOutcome(toOutcome(result));
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.page}>
        <BackButton onPress={onBack} />
        <Text accessibilityRole="header" style={type.title}>Request an increase</Text>
        <View style={styles.smallGap} />
        <Text style={type.bodyMuted}>
          {'Choose how much to add to your ' + moneyWhole(line.limitCents) + ' limit.'}
        </Text>
        <View style={styles.topGap} />

        <View style={styles.card}>
          <Text style={[styles.label, styles.centerText]}>INCREASE BY</Text>
          <View style={styles.tinyGap} />
          <Text
            accessibilityLiveRegion="polite"
            style={[type.display, styles.centerText, styles.numeric]}
          >
            {moneyWhole(amount)}
          </Text>

          {max > MIN_ASK_CENTS ? (
            <>
              <View style={styles.sliderRow}>
                <StepButton
                  label="−"
                  accessibilityLabel="Decrease by $50"
                  disabled={amount <= MIN_ASK_CENTS}
                  onPress={() => nudge(-STEP_CENTS)}
                />
                <View style={styles.flex}>
                  <Slider
                    accessibilityLabel="Amount to add"
                    aria-valuemin={MIN_ASK_CENTS / 100}
                    aria-valuemax={max / 100}
                    aria-valuenow={amount / 100}
                    aria-valuetext={moneyWhole(amount) + ' of up to ' + moneyWhole(max)}
                    maximumTrackTintColor={color.rule}
                    maximumValue={max / 100}
                    minimumTrackTintColor={color.accent}
                    minimumValue={MIN_ASK_CENTS / 100}
                    onValueChange={(dollars) =>
                      setAmount(Math.round((dollars * 100) / STEP_CENTS) * STEP_CENTS)}
                    step={STEP_CENTS / 100}
                    style={styles.slider}
                    thumbTintColor={color.accent}
                    value={amount / 100}
                  />
                  <View style={styles.rangeRow}>
                    <Text style={type.small}>{moneyWhole(MIN_ASK_CENTS)}</Text>
                    <Text style={type.small}>{moneyWhole(max)}</Text>
                  </View>
                </View>
                <StepButton
                  label="+"
                  accessibilityLabel="Increase by $50"
                  disabled={amount >= max}
                  onPress={() => nudge(STEP_CENTS)}
                />
              </View>
            </>
          ) : null}

          <View style={styles.divider} />
          <AccountRow label="New limit if approved" value={money(newLimit)} />
        </View>

        <View style={styles.flex} />
        <View style={styles.largeGap} />
        <Note text="It won't affect your credit score. We use a soft inquiry." />
        <Note text="You can only ask once, so pick the amount you'll want." />
        <View style={styles.smallGap} />
        <PrimaryButton
          busy={submitting}
          disabled={submitting}
          label={submitting ? 'Submitting…' : 'Submit request'}
          onPress={submit}
        />
      </View>
    </ScrollView>
  );
}

function ResultPage({
  line,
  outcome,
  onRetry,
  onReconcile,
  onDone,
}: {
  line: CreditLine;
  outcome: Outcome;
  onRetry: () => void;
  onReconcile: () => Promise<boolean>;
  onDone: () => void;
}) {
  if (outcome.kind === 'failed') {
    return <UncertainResult onReconcile={onReconcile} onDone={onDone} />;
  }
  if (outcome.kind === 'invalid') {
    return (
      <ResultFrame
        headline="That amount isn't available"
        detail={outcome.message}
        primary={{ label: 'Choose another amount', onPress: onRetry }}
        secondary={{ label: 'Back to Home', onPress: onDone }}
      />
    );
  }

  const { request } = outcome;
  if (request.status === 'APPROVED') {
    return (
      <ResultFrame
        headline="Approved"
        detail={'You added ' + moneyWhole(request.approvedCents) + ". It's ready to use now."}
        primary={{ label: 'Back to Home', onPress: onDone }}
      >
        <View style={styles.card}>
          <AccountRow
            label="Previous limit"
            value={money(request.newLimitCents - request.approvedCents)}
          />
          <View style={styles.smallGap} />
          <AccountRow label="New limit" value={money(request.newLimitCents)} />
          <View style={styles.divider} />
          <AccountRow label="Available to spend" value={money(availableCents(line, request.newLimitCents))} />
        </View>
      </ResultFrame>
    );
  }

  return (
    <ResultFrame
      headline="We can't raise your limit right now"
      detail={'Your limit stays at ' + money(line.limitCents) + '.'}
      primary={{ label: 'Back to Home', onPress: onDone }}
    >
      <View style={styles.card}>
        <DeclineReasons codes={request.reasonCodes} />
      </View>
      <View style={styles.mediumGap} />
      <Note text="This was a soft inquiry. It didn't affect your credit score." />
    </ResultFrame>
  );
}

// The request may or may not have been decided. Never offer a resubmit from
// here: only the account can say whether one is safe.
function UncertainResult({
  onReconcile,
  onDone,
}: {
  onReconcile: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const check = async () => {
    setChecking(true);
    // On success the screen changes and this component unmounts.
    if (!(await onReconcile())) {
      setChecking(false);
      setUnreachable(true);
    }
  };

  return (
    <ResultFrame
      headline="We couldn't confirm your request"
      detail={unreachable
        ? "We still can't reach your account. Your request may have gone through, so we won't send another until we can check."
        : "Your request may have gone through. We'll check your account before you can ask again, so it's never sent twice."}
      primary={{
        label: checking ? 'Checking…' : 'Check status',
        onPress: check,
        disabled: checking,
        busy: checking,
      }}
      secondary={{ label: 'Back to Home', onPress: onDone }}
    />
  );
}

function ResultFrame({
  headline,
  detail,
  primary,
  secondary,
  children,
}: {
  headline: string;
  detail: string;
  primary: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean };
  secondary?: { label: string; onPress: () => void };
  children?: React.ReactNode;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.page}>
        <View style={styles.resultTopGap} />
        <Text accessibilityRole="header" style={type.title}>{headline}</Text>
        <View style={styles.smallGap} />
        <Text style={type.bodyMuted}>{detail}</Text>
        <View style={styles.topGap} />
        {children}
        <View style={styles.flex} />
        <View style={styles.largeGap} />
        <PrimaryButton
          busy={primary.busy}
          disabled={primary.disabled}
          label={primary.label}
          onPress={primary.onPress}
        />
        {secondary ? (
          <>
            <View style={styles.smallGap} />
            <SecondaryButton label={secondary.label} onPress={secondary.onPress} />
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

function DeclineReasons({
  codes,
  copy = reasonCopy,
}: {
  codes: string[];
  copy?: Record<string, string>;
}) {
  return (
    <View>
      <Text style={styles.label}>WHY</Text>
      <View style={styles.tinyGap} />
      {codes.length === 0 ? (
        <Text style={type.body}>We couldn't load the reason. Contact support and we'll explain.</Text>
      ) : (
        codes.map((code) => (
          <View key={code} style={styles.bulletRow}>
            <Text style={type.body}>{'•'}</Text>
            <Text style={[type.body, styles.flex]}>
              {copy[code] ?? 'Reason code ' + code + '. Contact support and we\'ll explain.'}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function Note({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={type.small}>{'•'}</Text>
      <Text style={[type.small, styles.flex]}>{text}</Text>
    </View>
  );
}

function AccountRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.accountRow}>
      <Text style={type.bodyMuted}>{label}</Text>
      <Text style={type.numeric}>{value}</Text>
    </View>
  );
}

// Demo-only switches, styled like the baseline persona control.
function DemoPicker<T extends string>({
  label,
  value,
  options,
  describe,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  describe: (option: T) => string;
  onChange: (next: T) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.personaRow}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={'Current ' + label.toLowerCase() + ': ' + describe(value)}
        onPress={() => setOpen(true)}
        style={styles.personaButton}
      >
        <Text numberOfLines={1} style={type.small}>{describe(value)}</Text>
        <View style={styles.chevron} />
      </Pressable>

      <Modal animationType="fade" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.personaMenu}>
            <Text style={type.heading}>{'Choose ' + label.toLowerCase()}</Text>
            <View style={styles.smallGap} />
            {options.map((option) => (
              <Pressable
                accessibilityRole="button"
                key={option}
                onPress={() => {
                  onChange(option);
                  setOpen(false);
                }}
                style={({ pressed }) => [
                  styles.personaOption,
                  option === value && styles.personaOptionSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={option === value ? type.body : type.bodyMuted}>{describe(option)}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Back"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
    >
      <Text style={styles.backGlyph}>‹</Text>
    </Pressable>
  );
}

function StepButton({
  label,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.stepButton,
        disabled && styles.primaryButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={type.heading}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      aria-busy={busy}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && !busy && styles.primaryButtonDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <View style={styles.buttonContent}>
        {busy ? <ActivityIndicator color={color.accentInk} size="small" /> : null}
        <Text style={styles.primaryButtonText}>{label}</Text>
      </View>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
    >
      <Text style={[type.body, styles.centerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: color.paper,
  },
  scroll: { flexGrow: 1 },
  page: {
    alignSelf: 'center',
    backgroundColor: color.paper,
    flex: 1,
    padding: space.s5,
    width: '100%',
    maxWidth: 560,
  },
  flex: { flex: 1 },
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  centerText: { textAlign: 'center' },
  numeric: { fontVariant: ['tabular-nums'] },
  // Token label style in ink2: ink3 measures 2.9-3.1:1 on paper and surface,
  // under the 4.5:1 small text needs.
  label: { ...type.label, color: color.ink2 },
  demoDivider: {
    backgroundColor: color.rule,
    height: 1,
    marginBottom: space.s3,
  },
  topGap: { height: space.s5 },
  resultTopGap: { height: space.s7 },
  largeGap: { height: space.s5 },
  mediumGap: { height: space.s4 },
  smallGap: { height: space.s2 },
  tinyGap: { height: space.s1 },
  card: {
    backgroundColor: color.surface,
    borderColor: color.rule,
    borderRadius: radius,
    borderWidth: 1,
    padding: space.s4,
  },
  accountRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  bulletRow: {
    flexDirection: 'row',
    gap: space.s2,
    marginBottom: space.s1,
  },
  divider: {
    backgroundColor: color.rule,
    height: 1,
    marginVertical: space.s3,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: color.accent,
    borderRadius: radius,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: space.s4,
    paddingVertical: space.s3,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  buttonContent: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.s2,
  },
  primaryButtonText: {
    ...type.body,
    color: color.accentInk,
    fontWeight: '600',
  },
  secondaryButton: {
    borderColor: color.rule,
    borderRadius: radius,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: space.s4,
    paddingVertical: space.s2,
  },
  pressed: { opacity: 0.72 },
  sliderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.s2,
    marginTop: space.s2,
  },
  slider: {
    flex: 1,
    height: 44,
  },
  stepButton: {
    alignItems: 'center',
    borderColor: color.rule,
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    marginBottom: space.s1,
    marginLeft: -space.s3,
    width: 44,
  },
  backGlyph: {
    color: color.ink,
    fontSize: 36,
    lineHeight: 36,
  },
  personaRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  personaButton: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    minHeight: 44,
  },
  chevron: {
    borderBottomColor: color.ink2,
    borderBottomWidth: 2,
    borderRightColor: color.ink2,
    borderRightWidth: 2,
    height: 8,
    marginLeft: space.s2,
    marginTop: -4,
    transform: [{ rotate: '45deg' }],
    width: 8,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(20, 24, 27, 0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: space.s5,
  },
  personaMenu: {
    backgroundColor: color.surface,
    borderColor: color.rule,
    borderRadius: radius,
    borderWidth: 1,
    maxWidth: 420,
    padding: space.s4,
    width: '100%',
  },
  personaOption: {
    borderRadius: radius,
    minHeight: 44,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
  personaOptionSelected: { backgroundColor: color.accentSoft },
});
