- fare multiplier via admin
- suspend/banned driver via admin
- suspend/banned rider via admin

- Create web client production prototype. Add history for drivers and riders. Design it as cyberfunk yellow and black theme. a Make it PWA, mobile first bootstrap, vanillajs. Use vite setup, opensource map, typescript reactjs

# Admin features across **operations, finance, safety, and growth**. Here's a practical breakdown:

## 1. User Management
- **Rider management**: search, view profiles, trip history, suspend/ban, refund credits
- **Driver management**: onboarding approval, document verification (license, insurance, registration), background check status, activate/deactivate, tier/rating management
- **Role-based access control (RBAC)**: super admin, ops, finance, support, regional managers — each with scoped permissions
- **Audit logs**: who did what, when (critical for disputes and compliance)

## 2. Driver Onboarding & Verification
- Document upload review queue (approve/reject with reasons)
- Expiry tracking (license, insurance, vehicle inspection) with auto-reminders/suspension
- Vehicle management: make/model/year/plate, category (economy, XL, etc.)
- Background check integration status

## 3. Trip & Dispatch Management
- Live map of active trips and available drivers
- Manual dispatch/override (assign a driver to a rider)
- Trip details view: route, timestamps, fare breakdown, cancellations
- Force-cancel or reassign trips
- Surge pricing controls by zone/time
- Geofencing: service areas, airports, restricted zones

## 4. Pricing & Payments
- Fare configuration: base fare, per-km, per-minute, minimum fare, cancellation fees
- Promo codes & credits: create, limit, expire, track usage
- Commission/payout settings per driver or tier
- Payment gateway management, refunds, failed payment handling
- Driver earnings & payout dashboard (approve, hold, release)

## 5. Support & Dispute Resolution
- Ticket system linked to specific trips/users
- Lost item workflow
- Fare dispute adjustment (partial/full refunds)
- In-app chat/call logs access
- Chargeback and fraud case handling

## 6. Safety & Trust
- **SOS/panic button monitoring** with live location
- Incident reporting and escalation workflow
- Trip sharing / live trip monitoring
- Driver & rider rating/review moderation
- Blocklist (rider-driver pairing bans)
- Emergency contact and law enforcement request handling

## 7. Analytics & Reporting
- Real-time KPIs: active drivers, trips/min, acceptance rate, completion rate
- Revenue, commissions, refunds, net margin
- Driver utilization, idle time, heatmaps
- Rider retention, CAC, churn
- Exportable reports (CSV/PDF) for accounting and compliance

## 8. Notifications & Communications
- Push/SMS/email campaigns (segmented by user type, city, activity)
- In-app announcements/banners
- Automated triggers: driver doc expiry, promo, service alerts

## 9. Configuration & Platform Settings
- Service categories and vehicle types per city
- Language, currency, tax settings per region
- Cancellation policies and no-show rules
- Feature flags (roll out features gradually)
- App version control / force update

## 10. Compliance & Data
- GDPR/CCPA tools: data export, deletion requests
- Tax reporting (driver 1099s or local equivalents)
- Data retention policies
- Local regulatory reporting (varies by country)

## Nice-to-Haves
- Fraud detection dashboard (fake trips, GPS spoofing, promo abuse)
- Driver heatmap & incentive campaign manager
- A/B testing for pricing and promos
- Multi-city / multi-tenant support if you expand

## Priority Order (if building MVP first)
1. Driver onboarding + document verification
2. Trip monitoring + manual dispatch
3. User management (suspend/refund)
4. Payments, payouts, refunds
5. Support tickets + safety/SOS
6. Analytics
7. Promo/config tools

Want me to turn this into a feature spec or a database schema for the admin panel?