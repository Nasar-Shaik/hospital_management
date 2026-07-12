# PRODUCT TOUR — what this application is, in plain language

A guide to **what we are building and in what order**, written for someone who wants to click around and understand the product — not read architecture documents.

> **Quick correction, because it comes up:** this product manages **hospitals and clinics**, not schools. School ERP, College ERP and HRMS are _separate future products_ that will reuse this system's foundation (the tenancy, login, and permission machinery we've already built). Nothing in MediCore HMS creates a school.

---

## 1. What the product actually is

**MediCore HMS is hospital software sold as a subscription.** One codebase serves many hospitals at once — a 2-doctor dental clinic and a 900-bed multi-branch hospital network run the _same_ software, switched on differently.

Two ideas explain almost everything:

**① Every hospital gets its own private database.** When we create "Apollo Hospital", the system creates a database that only Apollo can ever touch. Apollo's patients are not in a shared table with a column saying "this row belongs to Apollo" — they are in a physically separate database. A hospital cannot see another hospital's data even if the software has a bug.

**② Which hospital you are is decided by the web address.** `apollo.paperlesstech.in` means Apollo. `sunshine.paperlesstech.in` means Sunshine. Later, a hospital can use its own domain (`hms.apollohospital.com`) and it works the same way. The address picks the database _before_ anything else happens.

---

## 2. Who uses it — four different audiences, four different apps

| Who they are                                       | What they use it for                                       | Where it lives                  |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| **Us (PaperlessTech staff)** — the SaaS operator   | Create hospitals, manage subscriptions, suspend non-payers | Admin console                   |
| **Hospital staff** — receptionists, nurses, admins | The day-to-day job: register patients, book appointments   | The hospital app                |
| **Doctors**                                        | See their patient list, write prescriptions, order tests   | The hospital app                |
| **Patients and the public**                        | Find the hospital, book an appointment, see reports        | Public website + patient portal |

All four are served by the same system. What each person can see and do is controlled by **permissions**, not by giving them different software.

---

## 3. What exists TODAY (you can test this now)

Honestly and precisely: **the engine works, the dashboard does not exist yet.**

✅ **Creating a hospital.** Run one command and a real hospital exists — its own database, its own admin account, ready to log into. (Today this is an operator command, not a screen. The screen comes in step 4 below.)

✅ **Logging in.** Email + password → you get a session. Includes the serious security work: password lockout after repeated failures, two-factor authentication (the 6-digit code from an authenticator app), "sign out my other device", and a password change that logs you out everywhere.

✅ **Hospital separation.** A staff member logged into Apollo _cannot_ reach Sunshine's data, even holding a valid Apollo login.

❌ **No screens yet.** There is no login page you can click. The web app at `localhost:3000` currently shows a status card, nothing more.

**So today you test with commands, not clicks.** See [TESTING.md](./TESTING.md).

---

## 4. What comes next — the screens, in build order

This is the order we build in, and each step is testable when it lands.

### Step 1 — Permissions (next up)

_No new screens, but nothing above is safe without it._

Right now, a logged-in admin can call any part of the system. Permissions fix that: a **receptionist** can register a patient but not view a lab result; a **nurse** can record vitals but not discharge; a **doctor** can prescribe. We define this list once, attach it to roles, and every screen we build afterwards is automatically protected.

> **Why before the login screen?** The login page's whole job is to let people into things they're allowed to see. Build the page first and we build it twice.

### Step 2 — The login screen and app shell

_The first thing you can actually click._

- **Login page** — email + password, on your hospital's address
- **Two-factor prompt** — the 6-digit code, when it's switched on
- **The shell** — the top bar and left sidebar every screen sits inside, showing your name, your hospital's logo, and only the menu items your role allows
- **My sessions** — "you're logged in on 3 devices; sign that one out"
- **Change password**

At this point you log in like a real user, in a browser.

### Step 3 — Hospital setup screens

_The first thing a new hospital does after logging in._

- **Hospital profile** — name, logo, address, registration numbers
- **Branches** — a hospital chain adds each location
- **Departments, buildings, floors**
- **Staff directory** — invite your colleagues by email; they set their own password
- **Roles** — decide what a "Receptionist" is allowed to do here

### Step 4 — The admin console (our side)

_The SaaS operator screens — this is your "create a hospital" screen._

- **Hospital list** — every customer, their plan, their status
- **Create hospital** — the screen version of the command that exists today
- **Subscription and plan** — which edition they bought, what it unlocks
- **Usage and limits** — "this clinic is at 90% of its patient limit"
- **Suspend / reactivate** — a non-paying hospital is locked out (their data is untouched)

Runs on a separate address from the hospital app, because hospital staff must never see it.

### Step 5 — Patients and appointments (**the product becomes useful here**)

- **Register patient** — name, phone, age; the system issues a hospital ID (UHID)
- **Patient search** — find someone by name, phone, or ID
- **Patient 360°** — one screen with everything about a patient
- **Doctor directory and schedules** — who works when
- **Appointment calendar** — book, reschedule, cancel
- **Queue / token board** — the screen in the waiting room showing whose turn it is
- **Reception console** — the front desk's home screen

### Step 6 — Doctors and clinical work

- **Doctor's daily list** — my patients today
- **Consultation workspace** — where the doctor writes notes during the visit
- **Prescription composer** — with allergy and drug-interaction warnings
- **Order tests** — send to lab or radiology
- **Nursing** — vitals, medication administration, shift handover
- **Bed board** — a live map of which beds are free, occupied, or being cleaned
- **Lab and radiology** — sample tracking, result entry, report sign-off

### Step 7 — Money

- **Billing** — OPD bills, IPD final bills, packages
- **Payments** — cash, card, UPI, online
- **Insurance claims** — pre-authorization through to settlement
- **Pharmacy** — prescriptions dispensed, stock deducted
- **Reports** — daily collection, revenue by department

### Step 8 — The public face

- **The hospital's public website** — doctors, departments, contact (each hospital gets one, on its own domain, in its own colors)
- **Online appointment booking** — a patient books without calling
- **Patient portal** — see my appointments, download my reports, pay my bill

### Later

Mobile apps (patient, doctor, nurse), telemedicine video consults, AI assistance (drafting notes, flagging risks — always advisory, never deciding), and hospital-to-hospital data exchange (ABDM, FHIR).

---

## 5. A day in the life — what it looks like when it's done

**7:00am** — Priya (receptionist) opens `apollo.paperlesstech.in`, logs in with her password and a 6-digit code. She sees the **reception console**. She cannot see the billing menu; she has no permission for it.

**9:15am** — A walk-in patient arrives. Priya registers him in 30 seconds; the system gives him UHID `APL-000241` and puts him in Dr Rao's queue. The **token board** in the waiting room updates.

**9:40am** — Dr Rao opens his **daily list**, clicks the patient, and lands in the **consultation workspace** with the man's history already on screen. He prescribes a drug; the system warns that the patient is allergic to it. He picks another, and orders a blood test.

**10:05am** — The lab sees the order appear on their **worklist**. The sample is collected and barcoded.

**11:30am** — The result is entered and signed off by the pathologist. Dr Rao and the patient are both notified. The patient opens the **patient portal** and downloads the report.

**12:00pm** — The patient pays at the counter. The bill already contains the consultation and the lab test — nobody typed them twice.

**Meanwhile, on our side:** in the **admin console**, we see Apollo used 241 patient registrations this month, 80% of their plan limit, and their subscription renews in 9 days.

---

## 6. Why one system serves a dental clinic and a 900-bed hospital

We do **not** build a different version for each customer. We sell **editions**, and an edition is just a list of switches:

- **Clinic edition** — appointments, prescriptions, simple billing. Beds, operation theatres and blood bank are switched _off_ — a dental clinic never sees a menu it doesn't need.
- **Hospital edition** — adds admissions, beds, wards, lab, radiology, pharmacy.
- **Enterprise edition** — adds multiple branches, insurance claims, advanced analytics, single sign-on.

Turning on "Blood Bank" for a customer is a setting we change, not code we write. This is the single most important commercial decision in the system: the moment we fork the code for one customer, we have two products to maintain forever.

---

## 7. Where to look right now

| I want to…                              | Go to                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Run it and try the login (via commands) | [TESTING.md](./TESTING.md)                                                        |
| Know exactly how much is built          | [00-PROGRESS-TRACKER.md](./AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md) |
| See every screen we plan to build       | [02-MODULE-CATALOG.md](./AI_Workflow/PlanofActionforHMS/02-MODULE-CATALOG.md)     |
| See the editions and what each unlocks  | [07-PRODUCT-EDITIONS.md](./AI_Workflow/PlanofActionforHMS/07-PRODUCT-EDITIONS.md) |

**Bottom line today:** the foundation (hospital separation + login + security) is finished and tested. The next two steps — permissions, then the login screen and app shell — are what turn it from something you test with commands into something you use with a mouse.
