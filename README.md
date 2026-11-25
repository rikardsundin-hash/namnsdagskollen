# Livets dagar · Namnsdagskollen

Öppna [Livets dagar](https://rikardsundin-hash.github.io/namnsdagskollen/). Vill du ha push på iPhone, lägg till appen på hemskärmen och öppna den där. Under **Mitt konto** kan du registrera enheten, skicka en manuell testnotis och aktivera den automatiska planen. Planen gäller alla registrerade enheter på kontot. Där kan du också stänga av en enhet eller hela planen.

Version 2.0 använder svensk tid och kl. 07:00 som standard. Välj tid, period och vad som ska påminnas under **Påminnelser**. Medan du är inloggad på enheten som aktiverade planen synkas sparade ändringar. Aktivera eller förnya planen från den enhet vars uppgifter du vill använda. Påminnelser upphör vid planens slutdatum. På låsskärmen visas en diskret text. Planen i molnet lagrar datum och tid, utan namn eller firanderubriker.

## Drift och test

- Den befintliga Edge-funktionen `ld-push` hanterar registrering, avstängning per enhet och manuell testnotis. `ld-push-dispatch` hanterar schemalagda utskick. Funktionsgatewayens JWT-kontroll är av för dispatch, som verifierar en kortlivad HMAC och förbrukar varje signerad tidsstämpel atomiskt. Den befintliga cron-hemligheten och VAPID-nycklarna hämtas server-side från `ld_push_config`.
- Migrationerna förutsätter de tidigare produktionstabellerna. Lägg in schema och reprisskydd, driftsätt dispatchfunktionen och installera sedan minutjobbet `ld-push-dispatch`. Jobbet använder `pg_cron` och `pg_net`. Kontrollera `cron.job_run_details` samt HTTP-status i `net._http_response`.
- Dispatch accepterar upp till 15 minuters fördröjning inom samma svenska kalenderdag. Dagen då klockan ställs fram flyttas en tid i den överhoppade timmen fram en timme. När timmen upprepas vid omställning till vintertid används den andra förekomsten.
- En reservation per prenumerationsadress och svensk kalenderdag förhindrar dubbla utskick även vid samtidiga körningar. Leverantörs- och nätverksfel loggas utan prenumerationsuppgifter. En reserverad leverans skickas högst en gång samma dag, även om ett leveransbesked saknas.
- Kör `supabase/tests/ld_dispatch.sql` som Postgres-administratör. Testdatan återställs automatiskt. Kör även `deno test --frozen --allow-env=ECE_KEYLOG,NODE_DEBUG,DEBUG,DEBUG_COLORS ../../tests/ld_dispatch_test.ts` från `supabase/functions/ld-push-dispatch`.

## AI-hälsningar

Välj **Skriv en hälsning** på ett firande, välj ton och tryck **Skapa med AI**. AI-förslag kräver ett inloggat och bekräftat konto. Du kan redigera och kopiera texten direkt. På telefonen lägger appen till tilltalsnamnet när firandet har en mottagare. OpenAI får bara typen av firande och vald ton. Förslaget kan även skrivas och kopieras utan AI. Spara ett valfritt telefonnummer under **Mina personer → Visa profil**. Välj det direkt från Kontakter om webbläsaren stöder kontaktväljaren. På iPhone kan du dela en kontakt från Kontakter, spara kontaktkortet i Filer och välja det i profilen. **Öppna SMS** öppnar ett utkast för den valda hälsningen i telefonens meddelandeapp.

Lägg in en OpenAI-projektnyckel som `OPENAI_API_KEY` under [Edge Function Secrets](https://supabase.com/dashboard/project/vwzblmjkshlctgnwgxct/functions/secrets). Dispatch för hälsningar ligger i Edge-funktionen `ld-greeting`, med separat verifiering av användartoken. Migrationen för hälsningar begränsar användningen till 20 försök per konto och svensk kalenderdag. Kör `deno test supabase/tests/ld_greeting_test.ts` från repots rot.
