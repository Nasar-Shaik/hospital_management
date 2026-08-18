/**
 * Every clinical read the doctor's screens make — declared here, never inside a screen.
 *
 * ── ONE PLACE, BECAUSE THE BRANCH PREFIX IS THE POINT ───────────────────────
 * The M0 rule is that a branch-sensitive key begins `[tenant, branch]`. A rule that must be
 * remembered at forty call sites is a rule that will be missed at one, and the symptom of missing
 * it is the previous site's patient list rendering for a frame after a switch — a clinical error,
 * not a rendering glitch. So screens do not build keys: they ask this module for a descriptor and
 * hand it straight to `useQuery`. `keys.ts` is still the only thing that can mint a key, and this
 * is the only thing that pairs one with the request it belongs to.
 *
 * ── AND BECAUSE THE KEY AND THE REQUEST MUST AGREE ──────────────────────────
 * A key that carries a filter the request does not send (or the reverse) caches one answer under
 * two names, or two answers under one. Declaring both halves in a single expression is what makes
 * that impossible to get wrong quietly.
 *
 * ── NOTHING HERE TOUCHES THE NETWORK DIRECTLY ───────────────────────────────
 * Every `queryFn` is a method on the shipped `ApiClient`. No `fetch`, no URL, no DTO of our own —
 * so auth, refresh-and-replay, the tenant host, `X-Active-Branch` and `ApiClientError` all come
 * from the one boundary that already has them.
 */
import type {
  Allergy,
  ApiClient,
  BedBoard,
  CatalogueItem,
  ChargeCategory,
  ConsultationNote,
  DoseSlot,
  Encounter,
  EncounterStatus,
  InboxMessage,
  MedicationAdministration,
  MedicationRoundRow,
  Order,
  Paged,
  Patient,
  Prescription,
  VitalsReading,
  WardNote,
  WorklistRow,
} from "@medicore/api-client";
import { queryKeys, type QueryScope } from "./keys";

/** A plain read: spread straight into `useQuery`. */
export interface Read<T> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
}

/** A paged read: spread straight into `useInfiniteQuery`. */
export interface InfiniteRead<T> {
  queryKey: readonly unknown[];
  queryFn: (context: { pageParam: number }) => Promise<Paged<T>>;
  initialPageParam: number;
  getNextPageParam: (last: Paged<T>) => number | undefined;
}

/**
 * A page a phone can hold and a ward round can scroll.
 *
 * Not the server's maximum. Each row costs one `getPatient` lookup to put a NAME on it (the
 * encounter payload carries `patientId` and nothing else), so a page of 100 would be a hundred
 * requests before the first row reads as a person.
 */
export const PAGE_SIZE = 20;

/**
 * The ward round's page.
 *
 * Larger than `PAGE_SIZE` because these rows are CHEAP: `/bed-board` supplies the name and UHID
 * for every occupied bed in one request, so an inpatient row costs no `getPatient` at all — the
 * reason `PAGE_SIZE` is 20 does not apply here. Still well under the server's 100 cap, so the
 * first bay paints without waiting for the whole hospital.
 */
export const INPATIENT_PAGE = 40;

/**
 * The filter half of a key, as a stable string.
 *
 * Sorted and `undefined`-stripped so that `{status, doctorId}` and `{doctorId, status}` are the
 * same cache entry — otherwise the same list is fetched twice and the two copies drift apart.
 */
function filterKey(filters: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(filters)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

/** `hasMore` is the server's word for it; `total` is a fallback for older responses. */
function nextPage<T>(last: Paged<T>): number | undefined {
  if (last.meta.hasMore === false) return undefined;
  if (last.meta.hasMore === true) return last.meta.page + 1;
  const total = last.meta.total;
  if (total === undefined)
    return last.items.length < last.meta.limit ? undefined : last.meta.page + 1;
  return last.meta.page * last.meta.limit < total ? last.meta.page + 1 : undefined;
}

export interface MyPatientsFilter {
  /** The signed-in user's id. The SERVER filters on it; this never filters client-side. */
  doctorId: string;
  /** `YYYY-MM-DD` in the branch's zone (`formatDayKey`), or omitted for every open visit. */
  date?: string;
  status?: EncounterStatus;
  /** `in_queue` + `in_progress` + `awaiting_results`, in token order. */
  queued?: boolean;
}

/**
 * The clinical reads, bound to one client and one branch scope.
 *
 * Built per render from `useMemo` in `useClinical()`; nothing is cached here, because the cache is
 * React Query's and keying it is this module's whole job.
 */
export function clinicalQueries(api: ApiClient, scope: QueryScope) {
  return {
    /**
     * The doctor's own list.
     *
     * `doctorId` goes to the SERVER (`GET /encounters?doctorId=`). Fetching the whole queue and
     * filtering it on the phone is the specific mistake the web app had to fix: its fallback
     * showed every unassigned patient to every doctor, so two doctors each believed the same
     * patient was theirs. Filtering server-side means the wrong rows never leave the database —
     * and a client-side filter would in any case be a UI convenience, never an access control.
     */
    myPatients(filter: MyPatientsFilter): InfiniteRead<Encounter> {
      const filters = filterKey({ ...filter, limit: PAGE_SIZE });
      return {
        queryKey: queryKeys.encounters(scope, filters),
        queryFn: ({ pageParam }) =>
          api.listEncounters({
            doctorId: filter.doctorId,
            ...(filter.date ? { date: filter.date } : {}),
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.queued ? { queued: true } : {}),
            page: pageParam,
            limit: PAGE_SIZE,
          }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },

    /** One page of the doctor's day, for a home-screen count. Deliberately not infinite. */
    roundToday(filter: MyPatientsFilter): Read<Paged<Encounter>> {
      const filters = filterKey({ ...filter, limit: PAGE_SIZE, view: "round" });
      return {
        queryKey: queryKeys.encounters(scope, filters),
        queryFn: () =>
          api.listEncounters({
            doctorId: filter.doctorId,
            ...(filter.date ? { date: filter.date } : {}),
            ...(filter.queued ? { queued: true } : {}),
            page: 1,
            limit: PAGE_SIZE,
          }),
      };
    },

    /** A patient's visits across every episode — the spine of their history. */
    patientEncounters(patientId: string): Read<Paged<Encounter>> {
      const filters = filterKey({ patientId, limit: PAGE_SIZE });
      return {
        queryKey: queryKeys.encounters(scope, filters),
        queryFn: () => api.listEncounters({ patientId, page: 1, limit: PAGE_SIZE }),
      };
    },

    encounter(id: string): Read<Encounter> {
      return { queryKey: queryKeys.encounter(scope, id), queryFn: () => api.getEncounter(id) };
    },

    /** Every encounter in one care story, oldest first (ADR-0013 §4). */
    episodeTimeline(episodeId: string): Read<Encounter[]> {
      return {
        queryKey: queryKeys.episodeTimeline(scope, episodeId),
        queryFn: () => api.getEpisodeTimeline(episodeId),
      };
    },

    /**
     * Everyone in a bed right now. Feature-gated on `module.ops.ipd` SERVER-SIDE — a clinic gets
     * `HMS-PLAN-002`, which is how the app learns the hospital has no wards without an
     * entitlements endpoint it has no permission to read (`/subscription` needs
     * `subscription:manage`, which no clinician holds).
     *
     * ── PAGED, IN THE SAME SHAPE AS EVERY OTHER LIST ────────────────────────────
     * A ward round is scrolled, so this is an infinite read like My Patients rather than a single
     * page with a warning on it. `INPATIENT_PAGE` is smaller than the server's default of 100 on
     * purpose: a phone renders the first bay in one round trip instead of waiting for a hundred
     * rows, and the rest arrives as the doctor walks.
     */
    inpatients(): InfiniteRead<Encounter> {
      const filters = filterKey({ limit: INPATIENT_PAGE });
      return {
        queryKey: queryKeys.inpatients(scope, filters),
        queryFn: ({ pageParam }) => api.listInpatients({ page: pageParam, limit: INPATIENT_PAGE }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },

    /**
     * How many patients are in beds — for the home screen's card, from `meta.total`.
     *
     * ── ONE ROW, AND THE COUNT IS EXACT ─────────────────────────────────────────
     * Same shape as `outstandingResults`: ask for a single row and read the server's own count off
     * the meta. Before this endpoint was paged the card could only count what it had received, so
     * a hospital with 140 open stays reported "100 in beds" — a wrong number stated as a fact, on
     * the first screen a doctor sees. It also drags one row of PHI over the wire instead of forty.
     */
    inpatientCount(): Read<Paged<Encounter>> {
      const filters = filterKey({ limit: 1, view: "count" });
      return {
        queryKey: queryKeys.inpatients(scope, filters),
        queryFn: () => api.listInpatients({ page: 1, limit: 1 }),
      };
    },

    /**
     * The ward worklist (M3-S3) — one page of admitted patients with allergy and due-dose state.
     *
     * ── THIS IS THE NURSE'S LIST, AND IT IS ONE REQUEST ─────────────────────────
     * Assembling the same view on the phone would cost a per-patient allergy call and a
     * per-encounter schedule call on top of the page itself: sixty-one requests for a twenty-bed
     * ward. The server does it in four queries, so this is the descriptor the worklist uses and
     * the per-patient reads are kept for the chart, where there is exactly one patient.
     *
     * `ward` is a SERVER filter, not a display one. The doctor's round filters wards in the client
     * because it has the whole branch in hand already; a nurse on a 300-bed site does not, and
     * paging through the hospital to find their own patients is not a workable ward round.
     */
    wardWorklist(ward?: string): InfiniteRead<WorklistRow> {
      const filters = filterKey({ limit: INPATIENT_PAGE, ward });
      return {
        queryKey: queryKeys.wardWorklist(scope, filters),
        queryFn: ({ pageParam }) =>
          api.listWardWorklist({
            page: pageParam,
            limit: INPATIENT_PAGE,
            ...(ward ? { ward } : {}),
          }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },

    /**
     * The medication round (M3-S5B) — one page of a ward with every dose expected on one day.
     *
     * ── THE DAY IS THE WARD'S, AND IT IS THE CALLER'S JOB TO SAY SO ─────────────
     * `date` is `YYYY-MM-DD` computed from the BRANCH's zone (`formatDayKey(now, zone)`), not the
     * handset's. At 23:30 in Delhi it is still yesterday afternoon in a New York ward, and the
     * round belongs to the ward's day; a phone that decided otherwise would show the wrong day's
     * doses at exactly the hour a night nurse is working. It is sent explicitly rather than left
     * to the server's default so that it is also in the KEY — two days must be two cache entries.
     *
     * One request per page for the whole round. Assembling it from `wardWorklist` plus a schedule
     * call per patient would be the N+1 S3 removed, and this endpoint exists so it stays removed.
     */
    medicationRound(filter: { ward?: string; date: string }): InfiniteRead<MedicationRoundRow> {
      const filters = filterKey({ limit: INPATIENT_PAGE, ward: filter.ward, date: filter.date });
      return {
        queryKey: queryKeys.medicationRound(scope, filters),
        queryFn: ({ pageParam }) =>
          api.listMedicationRound({
            page: pageParam,
            limit: INPATIENT_PAGE,
            date: filter.date,
            ...(filter.ward ? { ward: filter.ward } : {}),
          }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },

    /**
     * What is DUE on this stay today, and what has happened to each dose (M3-S1).
     *
     * Separate from `medications()`, which is the record of what was GIVEN. The server resolves
     * `due` / `overdue` in the branch's timezone against real administration rows — the phone
     * never decides whether a dose is late, because a handset with the wrong clock would then be
     * deciding whether a patient's antibiotic is overdue.
     */
    medicationSchedule(encounterId: string): Read<DoseSlot[]> {
      return {
        queryKey: queryKeys.medicationSchedule(scope, encounterId),
        queryFn: () => api.listMedicationSchedule(encounterId),
      };
    },

    /**
     * The bed estate, joined to who is in it. `emr:read` + `module.ops.ipd`.
     *
     * Read alongside the inpatient list rather than instead of it: this one carries ward, room,
     * bed and — for every occupied bed — the occupant's NAME and UHID resolved server-side in one
     * query, which is what lets a twenty-bed round render identity without twenty `getPatient`
     * calls. Occupancy comes from here and is never recomputed on the phone.
     */
    bedBoard(): Read<BedBoard> {
      return { queryKey: queryKeys.bedBoard(scope), queryFn: () => api.bedBoard() };
    },

    /**
     * The stay's running record — progress notes, the discharge summary, an outcome note.
     *
     * Unfiltered on purpose. `?type=` exists, but the chart wants the whole thread in one place:
     * a stay whose last entry is a discharge summary reads completely differently from one whose
     * last entry is a progress note, and asking for `progress` alone would hide the ending.
     */
    wardNotes(encounterId: string): Read<WardNote[]> {
      return {
        queryKey: queryKeys.wardNotes(scope, encounterId),
        queryFn: () => api.listWardNotes(encounterId),
      };
    },

    /**
     * The MAR — every dose given, held or refused on this stay.
     *
     * `emr:read`, which the doctor holds, behind `module.clinical.nursing`. This is the question a
     * ward round actually opens with ("did the morning dose go in?") and it is the only place the
     * answer exists: a signed prescription says what SHOULD happen, and only the MAR says what did.
     */
    medications(encounterId: string): Read<MedicationAdministration[]> {
      return {
        queryKey: queryKeys.medications(scope, encounterId),
        queryFn: () => api.listMedicationAdministrations(encounterId),
      };
    },

    patient(id: string): Read<Patient> {
      return { queryKey: queryKeys.patient(scope, id), queryFn: () => api.getPatient(id) };
    },

    /** Hospital-wide by design — see the note on the key. */
    allergies(patientId: string): Read<Allergy[]> {
      return {
        queryKey: queryKeys.patientAllergies(scope.tenantSlug, patientId),
        queryFn: () => api.listAllergies(patientId),
      };
    },

    /** This visit's chart, oldest first. */
    encounterVitals(encounterId: string): Read<VitalsReading[]> {
      return {
        queryKey: queryKeys.encounterVitals(scope, encounterId),
        queryFn: () => api.listEncounterVitals(encounterId),
      };
    },

    /** The trend across visits, newest first — what a chronic patient's clinician looks at. */
    patientVitals(patientId: string, limit = 20): Read<VitalsReading[]> {
      return {
        queryKey: queryKeys.patientVitals(scope, patientId),
        queryFn: () => api.listPatientVitals(patientId, limit),
      };
    },

    /** `null` when the doctor has not started one — an empty state, not an error. */
    consultation(encounterId: string): Read<ConsultationNote | null> {
      return {
        queryKey: queryKeys.consultation(scope, encounterId),
        queryFn: () => api.getConsultation(encounterId),
      };
    },

    patientOrders(patientId: string): Read<Paged<Order>> {
      const filters = filterKey({ patientId, limit: 50 });
      return {
        queryKey: queryKeys.orders(scope, filters),
        queryFn: () => api.listOrders({ patientId, page: 1, limit: 50 }),
      };
    },

    /**
     * How many tests are still out — for a home-screen count, from `meta.total`.
     *
     * ── THE COUNT IS EXACT; A CRITICAL COUNT COULD NOT BE ───────────────────────
     * `outstanding=true` is a server filter, so `meta.total` is the real number however many pages
     * it spans. There is deliberately no companion "critical" count here: the orders endpoint has no
     * `critical` filter, a released critical result is by definition NOT outstanding, and computing
     * one would mean paging every order the branch has ever raised. A number a phone cannot compute
     * honestly is not shown as a number — criticals are surfaced where they can be surfaced
     * completely, by sort order and marker, on the results list and the chart.
     */
    outstandingResults(): Read<Paged<Order>> {
      const filters = filterKey({ outstanding: true, limit: 1, view: "count" });
      return {
        queryKey: queryKeys.orders(scope, filters),
        queryFn: () => api.listOrders({ outstanding: true, page: 1, limit: 1 }),
      };
    },

    /**
     * The results worklist. `outstanding` is the server's own filter, so "what am I waiting for"
     * is answered by the database rather than by paging everything and counting on the phone.
     */
    orders(filter: { outstanding?: boolean } = {}): InfiniteRead<Order> {
      const filters = filterKey({ ...filter, limit: PAGE_SIZE });
      return {
        queryKey: queryKeys.orders(scope, filters),
        queryFn: ({ pageParam }) =>
          api.listOrders({
            ...(filter.outstanding ? { outstanding: true } : {}),
            page: pageParam,
            limit: PAGE_SIZE,
          }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },

    order(id: string): Read<Order> {
      return { queryKey: queryKeys.order(scope, id), queryFn: () => api.getOrder(id) };
    },

    /**
     * What the doctor may order or prescribe. NO PRICES — same collection as the tariff, stripped,
     * so a patient's means cannot shape what they are offered (`billing.routes.ts`).
     */
    catalogue(category?: ChargeCategory): Read<CatalogueItem[]> {
      return {
        queryKey: queryKeys.catalogue(scope, category),
        queryFn: () => api.listCatalogue(category ? { category } : {}),
      };
    },

    /** One prescription, by id — the oracle the sign reconciliation reads. */
    prescription(id: string): Read<Prescription> {
      return {
        queryKey: queryKeys.prescription(scope, id),
        queryFn: () => api.getPrescription(id),
      };
    },

    /** `current: true` — a chart shows what is in force, not the versions it replaced. */
    prescriptions(patientId: string): Read<Prescription[]> {
      const filters = filterKey({ patientId, current: true, limit: 50 });
      return {
        queryKey: queryKeys.prescriptions(scope, filters),
        queryFn: () => api.listPrescriptions({ patientId, current: true, limit: 50 }),
      };
    },

    /**
     * The signed-in person's own inbox (M4).
     *
     * ── THE ONLY READ HERE KEYED ON THE TENANT, NOT THE SCOPE ───────────────
     * Every other descriptor in this file passes `scope`, which carries the branch. This one
     * passes `scope.tenantSlug` alone, because `GET /notifications/me` applies no branch filter:
     * a message is addressed to a person, and a doctor who switches sites must not watch their
     * unread count fall to zero. Keying it per branch would also cache one answer under two names
     * and re-fetch it on every switch. See `keys.ts` and `COMMUNICATION_POLICY.md`.
     */
    notifications(filter: { unread?: boolean } = {}): InfiniteRead<InboxMessage> {
      const filters = filterKey({ ...filter, limit: PAGE_SIZE });
      return {
        queryKey: queryKeys.notifications(scope.tenantSlug, filters),
        queryFn: ({ pageParam }) =>
          api.myNotifications({
            ...(filter.unread ? { unread: true } : {}),
            page: pageParam,
            limit: PAGE_SIZE,
          }),
        initialPageParam: 1,
        getNextPageParam: nextPage,
      };
    },
  };
}

export type ClinicalQueries = ReturnType<typeof clinicalQueries>;
