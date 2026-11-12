#region Using declarations
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Globalization;
using System.Timers;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
#endregion

// Futures Journal PRO – NinjaTrader 8 Execution + Position Sync Connector
// FJ_CONNECTOR_VERSION: 5
// (Zvyš při každé změně toho, co konektor posílá – aplikace podle toho pozná
// zastaralou instalaci v NT a jednou nabídne přeinstalaci.)
// Exekuce se posílají okamžitě. Úplný stav pozic se posílá při každé změně
// a navíc jednou za minutu jako kontrola proti zůstatkovým/neplatným pozicím.

namespace NinjaTrader.NinjaScript.AddOns
{
    public class FuturesJournalCapture : AddOnBase
    {
        private const string ENDPOINT = "http://127.0.0.1:17654/api/v1/events";
        private const string API_KEY = "SEM_VLOZ_API_KLIC_Z_APLIKACE";
        private static readonly HttpClient Client = new HttpClient();

        // VWAP v čase vstupu (verze 4). Po každé vstupní exekuci se z 1min barů
        // od začátku seance spočte VWAP = součet(typická cena × objem) / součet
        // objemu a pošle se jako zpráva "entry_vwap". Běží mimo hlavní vlákno NT,
        // jen jednou na vstup. Vypnutí: SEND_ENTRY_VWAP = false.
        // Seance: prázdné VWAP_TRADING_HOURS = Trading Hours šablona instrumentu
        // (stejná jako v grafu s výchozím nastavením). Aby čísla seděla s LTA
        // VWAP v grafu, napiš sem název šablony, kterou má graf (např.
        // "CME US Index Futures RTH").
        private const bool SEND_ENTRY_VWAP = true;
        private const string VWAP_TRADING_HOURS = "";

        // Minutové svíčky dne (verze 5, Data trhu v aplikaci). Konektor se
        // aplikace ptá, jestli chce svíčky (GET /api/v1/market/requests): po
        // spuštění, jednou za minutu a po každé výstupní exekuci. Aplikace
        // s vypnutým ukládáním svíček vrací prázdnou odpověď a nic se nestahuje.
        // Svíčky celé seance (BarsRequest 1 min, jen čtení) jdou zprávou
        // "market_bars". Svíčky mimo hledanou seanci se zahodí – v Playbacku
        // NinjaTrader vrací jen přehrávaný den, i když se žádá jiný.
        // Vypnutí: SEND_MARKET_BARS = false. Šablona seance: prázdné
        // MARKET_TRADING_HOURS = Trading Hours instrumentu (jako u VWAP).
        private const bool SEND_MARKET_BARS = true;
        private const string MARKET_TRADING_HOURS = "";
        private const string CONNECTOR_VERSION = "5";
        private static int marketPolling = 0;
        private Timer syncTimer;
        // NinjaTrader umí znovu vyvolat ExecutionUpdate pro fill, který už jednou
        // proběhl – typicky po výpadku a obnovení spojení s brokerem/simulátorem.
        // Bez téhle pojistky se stejná exekuce pošle znovu a v deníku se objeví
        // jako duplicitní cíl (např. TP3 navíc u pozice se dvěma kontrakty).
        private readonly HashSet<string> sentExecutionIds = new HashSet<string>();

        protected override void OnStateChange()
        {
            if (State == State.Active)
            {
                foreach (Account account in Account.All) Subscribe(account);
                Account.AccountStatusUpdate += OnAccountStatusUpdate;

                syncTimer = new Timer(60000);
                syncTimer.AutoReset = true;
                syncTimer.Elapsed += OnSyncTimer;
                syncTimer.Start();

                SendAllPositionSnapshots();
                PollMarketRequests();
            }
            else if (State == State.Terminated)
            {
                Account.AccountStatusUpdate -= OnAccountStatusUpdate;
                foreach (Account account in Account.All) Unsubscribe(account);
                if (syncTimer != null)
                {
                    syncTimer.Stop();
                    syncTimer.Elapsed -= OnSyncTimer;
                    syncTimer.Dispose();
                    syncTimer = null;
                }
            }
        }

        private void OnAccountStatusUpdate(object sender, AccountStatusEventArgs e)
        {
            if (e.Account != null)
            {
                Subscribe(e.Account);
                SendPositionSnapshot(e.Account);
            }
        }

        private void Subscribe(Account account)
        {
            account.ExecutionUpdate -= OnExecutionUpdate;
            account.ExecutionUpdate += OnExecutionUpdate;
            account.PositionUpdate -= OnPositionUpdate;
            account.PositionUpdate += OnPositionUpdate;
        }

        private void Unsubscribe(Account account)
        {
            account.ExecutionUpdate -= OnExecutionUpdate;
            account.PositionUpdate -= OnPositionUpdate;
        }

        private void OnSyncTimer(object sender, ElapsedEventArgs e)
        {
            SendAllPositionSnapshots();
            PollMarketRequests();
        }

        private void OnPositionUpdate(object sender, PositionEventArgs e)
        {
            Account account = sender as Account;
            if (account != null) SendPositionSnapshot(account);
        }

        private void SendAllPositionSnapshots()
        {
            try
            {
                foreach (Account account in Account.All) SendPositionSnapshot(account);
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture position sync error: " + ex.Message);
            }
        }

        private async void SendPositionSnapshot(Account account)
        {
            try
            {
                if (account == null) return;
                StringBuilder positions = new StringBuilder();
                positions.Append("[");
                bool first = true;
                foreach (Position p in account.Positions)
                {
                    if (p == null || p.Instrument == null || p.Quantity == 0 || p.MarketPosition == MarketPosition.Flat) continue;
                    if (!first) positions.Append(",");
                    first = false;
                    string instrument = p.Instrument.MasterInstrument != null ? p.Instrument.MasterInstrument.Name : p.Instrument.FullName;
                    string instrumentFull = p.Instrument.FullName ?? instrument;
                    double pointValue = p.Instrument.MasterInstrument != null ? p.Instrument.MasterInstrument.PointValue : 1.0;
                    positions.Append("{")
                        .Append("\"instrument\":\"").Append(Escape(instrument)).Append("\",")
                        .Append("\"instrumentFull\":\"").Append(Escape(instrumentFull)).Append("\",")
                        .Append("\"quantity\":").Append(Math.Abs(p.Quantity)).Append(",")
                        .Append("\"avgPrice\":").Append(p.AveragePrice.ToString(CultureInfo.InvariantCulture)).Append(",")
                        .Append("\"marketPosition\":\"").Append(p.MarketPosition).Append("\",")
                        .Append("\"pointValue\":").Append(pointValue.ToString(CultureInfo.InvariantCulture))
                        .Append("}");
                }
                positions.Append("]");

                string json = "{" +
                    "\"source\":\"ninjatrader\"," +
                    "\"type\":\"position_snapshot\"," +
                    "\"account\":\"" + Escape(account.Name) + "\"," +
                    "\"time\":\"" + DateTime.UtcNow.ToString("o") + "\"," +
                    "\"positions\":" + positions.ToString() +
                "}";
                await PostJson(json);
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture snapshot error: " + ex.Message);
            }
        }

        private async void OnExecutionUpdate(object sender, ExecutionEventArgs e)
        {
            try
            {
                Execution x = e.Execution;
                if (x == null || x.Instrument == null) return;

                // Pojistka proti opakovanému odeslání téže exekuce (viz komentář u
                // sentExecutionIds výše). Pokud NinjaTrader nemá pro exekuci ID,
                // dedup se přeskočí – to je vzácné a lepší poslat než ztratit obchod.
                if (!string.IsNullOrEmpty(x.ExecutionId) && !sentExecutionIds.Add(x.ExecutionId))
                {
                    Print("FuturesJournalCapture: přeskočena opakovaně nahlášená exekuce " + x.ExecutionId);
                    return;
                }

                string account = x.Account != null ? x.Account.Name : "";
                string instrument = x.Instrument.MasterInstrument != null ? x.Instrument.MasterInstrument.Name : x.Instrument.FullName;
                string instrumentFull = x.Instrument.FullName ?? instrument;
                string action = x.Order != null ? x.Order.OrderAction.ToString() : "";
                string orderName = x.Order != null ? x.Order.Name : x.Name;
                string orderId = x.Order != null ? x.Order.OrderId : x.OrderId;
                double pointValue = x.Instrument.MasterInstrument != null ? x.Instrument.MasterInstrument.PointValue : 1.0;
                double tickSize = x.Instrument.MasterInstrument != null ? x.Instrument.MasterInstrument.TickSize : 0;
                if (!IsUsablePrice(tickSize)) tickSize = 0;

                // Průběh ceny (MAE/MFE) posílá jen výstup – vstupní exekuce ho
                // v tu chvíli ještě nezná.
                string excursion = x.IsExit ? ExcursionJson(x) : "";

                string json = "{" +
                    "\"source\":\"ninjatrader\"," +
                    "\"type\":\"execution\"," +
                    "\"account\":\"" + Escape(account) + "\"," +
                    "\"instrument\":\"" + Escape(instrument) + "\"," +
                    "\"instrumentFull\":\"" + Escape(instrumentFull) + "\"," +
                    "\"time\":\"" + x.Time.ToUniversalTime().ToString("o") + "\"," +
                    "\"price\":" + x.Price.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"quantity\":" + x.Quantity + "," +
                    "\"commission\":" + x.Commission.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"rate\":" + x.Rate.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"pointValue\":" + pointValue.ToString(CultureInfo.InvariantCulture) + "," +
                    "\"positionAfter\":" + x.Position + "," +
                    "\"marketPosition\":\"" + x.MarketPosition + "\"," +
                    "\"orderAction\":\"" + Escape(action) + "\"," +
                    "\"orderName\":\"" + Escape(orderName) + "\"," +
                    "\"orderId\":\"" + Escape(orderId) + "\"," +
                    "\"executionId\":\"" + Escape(x.ExecutionId) + "\"," +
                    "\"tickSize\":" + tickSize.ToString(CultureInfo.InvariantCulture) +
                    excursion +
                "}";

                await PostJson(json);
                if (x.Account != null) SendPositionSnapshot(x.Account);
                if (x.IsEntry) SendEntryVwap(x);
                // Po výstupu má aplikace případně požadavek na svíčky dne.
                if (x.IsExit) PollMarketRequests();
            }
            catch (Exception ex)
            {
                Print("FuturesJournalCapture error: " + ex.Message);
            }
        }

        // Nejvyšší a nejnižší cena, kterou pozice zažila od vstupu do tohoto výstupu.
        //
        // NinjaTrader si u KAŽDÉ vstupní exekuce účtu vede Execution.MaxPrice /
        // MinPrice – extrém ceny od fillu, dokud je pozice otevřená (ověřeno
        // v NinjaTrader.sqlite, tabulka Executions: vyplněné u ATM i u čistě ručních
        // obchodů bez strategie). Z těch samých hodnot počítá MAE/MFE okno Trade
        // Performance. Objekt Trade s vlastnostmi MaeTicks/MfeTicks add-on nemá
        // (Account žádnou kolekci Trade ani TradesPerformance nevystavuje), proto
        // se čte přímo z exekucí.
        //
        // Pozice = vstupy od poslední exekuce, po které byl účet na instrumentu
        // plochý (Execution.Position je pozice PO exekuci). Hledá se v
        // account.Executions, ne ve vlastním seznamu, aby to fungovalo i po
        // restartu add-onu uprostřed otevřené pozice.
        //
        // Hodnoty, které NT nesledoval (obchod proběhl bez dat v NT), mají
        // sentinel ±double.MaxValue – takové vstupy se přeskočí. Když nezbude
        // žádný, pole se nepošlou vůbec: prázdno, ne nula.
        private static string ExcursionJson(Execution exit)
        {
            try
            {
                Account account = exit.Account;
                if (account == null) return "";
                List<Execution> same = new List<Execution>();
                lock (account.Executions)
                {
                    foreach (Execution e in account.Executions)
                    {
                        if (e == null || e.Instrument == null || e == exit) continue;
                        if (e.ExecutionId == exit.ExecutionId && !string.IsNullOrEmpty(e.ExecutionId)) continue;
                        if (e.Instrument.FullName != exit.Instrument.FullName) continue;
                        if (e.Time > exit.Time) continue;
                        same.Add(e);
                    }
                }
                same.Sort((a, b) => a.Time != b.Time ? a.Time.CompareTo(b.Time) : a.Id.CompareTo(b.Id));

                double max = double.MinValue, min = double.MaxValue;
                bool any = false;
                for (int i = same.Count - 1; i >= 0; i--)
                {
                    Execution e = same[i];
                    if (e.Position == 0) break;
                    if (!e.IsEntry) continue;
                    if (!IsUsablePrice(e.MaxPrice) || !IsUsablePrice(e.MinPrice) || e.MaxPrice < e.MinPrice) continue;
                    max = Math.Max(max, e.MaxPrice);
                    min = Math.Min(min, e.MinPrice);
                    any = true;
                }
                if (!any || !IsUsablePrice(max) || !IsUsablePrice(min)) return "";
                return ",\"excursionMaxPrice\":" + max.ToString(CultureInfo.InvariantCulture) +
                       ",\"excursionMinPrice\":" + min.ToString(CultureInfo.InvariantCulture);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process("FuturesJournalCapture excursion error: " + ex.Message, PrintTo.OutputTab1);
                return "";
            }
        }

        // VWAP seance do času vstupu. Bary se počítají ty, které skončily
        // nejpozději v čase vstupu (čas baru = jeho konec); vstup v první minutě
        // seance vezme první bar. Chyba nebo chybějící data = zpráva se nepošle,
        // obchod se importuje normálně.
        private void SendEntryVwap(Execution x)
        {
            try
            {
                if (!SEND_ENTRY_VWAP || x == null || x.Instrument == null || string.IsNullOrEmpty(x.ExecutionId)) return;
                Instrument instrument = x.Instrument;
                TradingHours hours = !string.IsNullOrEmpty(VWAP_TRADING_HOURS)
                    ? TradingHours.Get(VWAP_TRADING_HOURS)
                    : (instrument.MasterInstrument != null ? instrument.MasterInstrument.TradingHours : null);
                if (hours == null) return;
                DateTime entryTime = x.Time;
                SessionIterator sessions = new SessionIterator(hours);
                if (!sessions.GetNextSession(entryTime, true)) return;
                DateTime sessionBegin = sessions.ActualSessionBegin;
                if (sessionBegin > entryTime) return;

                string executionId = x.ExecutionId;
                string account = x.Account != null ? x.Account.Name : "";
                string instrumentFull = instrument.FullName ?? "";
                string hoursName = hours.Name ?? "";

                BarsRequest request = new BarsRequest(instrument, sessionBegin, entryTime.AddMinutes(1));
                request.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
                request.TradingHours = hours;
                request.Request(async (req, code, message) =>
                {
                    try
                    {
                        if (code != ErrorCode.NoError || req.Bars == null)
                        {
                            NinjaTrader.Code.Output.Process("FuturesJournalCapture VWAP: data nejsou k dispozici (" + code + " " + message + ")", PrintTo.OutputTab1);
                            return;
                        }
                        Bars bars = req.Bars;
                        double pv = 0, volume = 0;
                        int firstIndex = -1;
                        for (int i = 0; i < bars.Count; i++)
                        {
                            DateTime t = bars.GetTime(i);
                            if (t <= sessionBegin) continue;
                            if (firstIndex < 0) firstIndex = i;
                            if (t > entryTime) break;
                            double v = bars.GetVolume(i);
                            if (v <= 0) continue;
                            pv += (bars.GetHigh(i) + bars.GetLow(i) + bars.GetClose(i)) / 3.0 * v;
                            volume += v;
                        }
                        if (volume <= 0 && firstIndex >= 0)
                        {
                            double v = bars.GetVolume(firstIndex);
                            if (v > 0)
                            {
                                pv = (bars.GetHigh(firstIndex) + bars.GetLow(firstIndex) + bars.GetClose(firstIndex)) / 3.0 * v;
                                volume = v;
                            }
                        }
                        if (volume <= 0) return;
                        double vwap = pv / volume;
                        if (!IsUsablePrice(vwap)) return;

                        string json = "{" +
                            "\"source\":\"ninjatrader\"," +
                            "\"type\":\"entry_vwap\"," +
                            "\"account\":\"" + Escape(account) + "\"," +
                            "\"instrumentFull\":\"" + Escape(instrumentFull) + "\"," +
                            "\"executionId\":\"" + Escape(executionId) + "\"," +
                            "\"time\":\"" + entryTime.ToUniversalTime().ToString("o") + "\"," +
                            "\"sessionBegin\":\"" + sessionBegin.ToUniversalTime().ToString("o") + "\"," +
                            "\"tradingHours\":\"" + Escape(hoursName) + "\"," +
                            "\"vwap\":" + vwap.ToString(CultureInfo.InvariantCulture) +
                        "}";
                        await PostJson(json);
                    }
                    catch (Exception ex)
                    {
                        NinjaTrader.Code.Output.Process("FuturesJournalCapture VWAP error: " + ex.Message, PrintTo.OutputTab1);
                    }
                    finally
                    {
                        req.Dispose();
                    }
                });
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process("FuturesJournalCapture VWAP error: " + ex.Message, PrintTo.OutputTab1);
            }
        }

        // Vyzvedne požadavky na svíčky dne a vyřídí je po jednom. Běží vždy jen
        // jednou naráz; dokud aplikace něco vrací, ptá se hned znovu (zpětné
        // doplnění tak neběží po minutách). Chyba = konec kola, zkusí se příště.
        private async void PollMarketRequests()
        {
            if (!SEND_MARKET_BARS) return;
            if (System.Threading.Interlocked.Exchange(ref marketPolling, 1) == 1) return;
            try
            {
                string url = ENDPOINT.Replace("/api/v1/events", "/api/v1/market/requests");
                for (int round = 0; round < 2000; round++)
                {
                    string text;
                    using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                    {
                        request.Headers.Add("X-FJ-API-Key", API_KEY);
                        request.Headers.Add("X-FJ-Connector-Version", CONNECTOR_VERSION);
                        HttpResponseMessage response = await Client.SendAsync(request);
                        // Starší aplikace tuhle adresu nezná (404) – nic se neděje.
                        if (!response.IsSuccessStatusCode) return;
                        text = await response.Content.ReadAsStringAsync();
                    }
                    if (string.IsNullOrWhiteSpace(text)) return;
                    foreach (string line in text.Split('\n'))
                    {
                        string[] f = line.TrimEnd('\r').Split('\t');
                        if (f.Length < 5 || f[0].Length == 0) continue;
                        await SendMarketBars(f[0], f[1], f[2], f[3], f[4]);
                    }
                }
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process("FuturesJournalCapture svíčky: " + ex.Message, PrintTo.OutputTab1);
            }
            finally
            {
                System.Threading.Interlocked.Exchange(ref marketPolling, 0);
            }
        }

        // Svíčky 1 min celé seance, která obsahuje čas `timeIso` (UTC), pro
        // kontrakt `full`, nebo pro kořen `root` (kontrakt podle rolloverů
        // NinjaTraderu k tomu dni). Výsledek nebo chyba jde zprávou market_bars.
        private async System.Threading.Tasks.Task SendMarketBars(string id, string root, string full, string day, string timeIso)
        {
            string error = null;
            string instrumentFull = full ?? "";
            string hoursName = "";
            DateTime sessionBegin = DateTime.MinValue, sessionEnd = DateTime.MinValue;
            StringBuilder bars = new StringBuilder();
            try
            {
                DateTime atUtc;
                if (!DateTime.TryParse(timeIso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out atUtc))
                    error = "bad_time";
                else
                {
                    // Časy NinjaTraderu jsou místní (stejně jako Execution.Time výše).
                    DateTime at = DateTime.SpecifyKind(atUtc, DateTimeKind.Utc).ToLocalTime();
                    Instrument instrument = ResolveInstrument(full, root, at);
                    if (instrument == null) error = "instrument_not_found";
                    else
                    {
                        instrumentFull = instrument.FullName ?? "";
                        TradingHours hours = !string.IsNullOrEmpty(MARKET_TRADING_HOURS)
                            ? TradingHours.Get(MARKET_TRADING_HOURS)
                            : (instrument.MasterInstrument != null ? instrument.MasterInstrument.TradingHours : null);
                        if (hours == null) error = "no_trading_hours";
                        else
                        {
                            hoursName = hours.Name ?? "";
                            SessionIterator sessions = new SessionIterator(hours);
                            if (!sessions.GetNextSession(at, true)) error = "no_session";
                            else
                            {
                                sessionBegin = sessions.ActualSessionBegin;
                                sessionEnd = sessions.ActualSessionEnd;
                                DateTime to = sessionEnd < DateTime.Now ? sessionEnd : DateTime.Now;
                                if (to <= sessionBegin) error = "session_not_started";
                                else error = await FetchMinuteBars(instrument, hours, sessionBegin, sessionEnd, to, bars);
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                error = "error: " + ex.Message;
            }

            string json = "{" +
                "\"source\":\"ninjatrader\"," +
                "\"type\":\"market_bars\"," +
                "\"requestId\":\"" + Escape(id) + "\"," +
                "\"root\":\"" + Escape(root) + "\"," +
                "\"instrumentFull\":\"" + Escape(instrumentFull) + "\"," +
                "\"day\":\"" + Escape(day) + "\"," +
                "\"tradingHours\":\"" + Escape(hoursName) + "\"," +
                "\"timeZone\":\"" + Escape(NtTimeZoneId()) + "\"," +
                (sessionBegin > DateTime.MinValue ? "\"sessionBegin\":\"" + sessionBegin.ToUniversalTime().ToString("o") + "\"," : "") +
                (sessionEnd > DateTime.MinValue ? "\"sessionEnd\":\"" + sessionEnd.ToUniversalTime().ToString("o") + "\"," : "") +
                (error != null
                    ? "\"error\":\"" + Escape(error.Replace("\r", " ").Replace("\n", " ")) + "\""
                    : "\"bars\":[" + bars.ToString() + "]") +
            "}";
            await PostJson(json);
        }

        // Stáhne 1min svíčky (from, to] a zapíše jen ty, které končí uvnitř
        // seance (sessionBegin, sessionEnd]. Vrací null, nebo kód chyby.
        private static async System.Threading.Tasks.Task<string> FetchMinuteBars(Instrument instrument, TradingHours hours, DateTime sessionBegin, DateTime sessionEnd, DateTime to, StringBuilder bars)
        {
            var tcs = new System.Threading.Tasks.TaskCompletionSource<string>();
            BarsRequest request = new BarsRequest(instrument, sessionBegin, to.AddMinutes(1));
            request.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Minute, Value = 1 };
            request.TradingHours = hours;
            try
            {
                request.Request((req, code, message) =>
                {
                    try
                    {
                        if (code != ErrorCode.NoError || req.Bars == null) { tcs.TrySetResult("data: " + code + " " + message); return; }
                        Bars b = req.Bars;
                        int inside = 0, outside = 0;
                        for (int i = 0; i < b.Count; i++)
                        {
                            DateTime t = b.GetTime(i);
                            double o = b.GetOpen(i), h = b.GetHigh(i), l = b.GetLow(i), c = b.GetClose(i);
                            if (t <= sessionBegin || t > sessionEnd) { outside++; continue; }
                            if (!IsUsablePrice(o) || !IsUsablePrice(h) || !IsUsablePrice(l) || !IsUsablePrice(c)) continue;
                            if (inside > 0) bars.Append(",");
                            bars.Append("[\"").Append(t.ToUniversalTime().ToString("o")).Append("\",")
                                .Append(o.ToString(CultureInfo.InvariantCulture)).Append(",")
                                .Append(h.ToString(CultureInfo.InvariantCulture)).Append(",")
                                .Append(l.ToString(CultureInfo.InvariantCulture)).Append(",")
                                .Append(c.ToString(CultureInfo.InvariantCulture)).Append(",")
                                .Append(b.GetVolume(i).ToString(CultureInfo.InvariantCulture)).Append("]");
                            inside++;
                        }
                        tcs.TrySetResult(inside > 0 ? null : (outside > 0 ? "out_of_range" : "empty"));
                    }
                    catch (Exception ex) { tcs.TrySetResult("error: " + ex.Message); }
                });
                var finished = await System.Threading.Tasks.Task.WhenAny(tcs.Task, System.Threading.Tasks.Task.Delay(120000));
                return finished == tcs.Task ? tcs.Task.Result : "timeout";
            }
            finally
            {
                request.Dispose();
            }
        }

        // Kontrakt: přesný název z obchodu, jinak kořen + kontrakt platný k datu
        // podle rolloverů NinjaTraderu (Instrumenty → kořen → Rollovers).
        private static Instrument ResolveInstrument(string full, string root, DateTime at)
        {
            if (!string.IsNullOrEmpty(full))
            {
                Instrument exact = Instrument.GetInstrument(full);
                if (exact != null) return exact;
            }
            if (string.IsNullOrEmpty(root)) return null;
            // Nejbližší existující kontrakt od měsíce obchodu dál (čtvrtletní i měsíční).
            Instrument nearest = null;
            for (int m = 0; m < 15 && nearest == null; m++)
                nearest = Instrument.GetInstrument(root + " " + at.AddMonths(m).ToString("MM-yy", CultureInfo.InvariantCulture));
            if (nearest == null || nearest.MasterInstrument == null) return nearest;
            // Rollovery přes reflexi – názvy vlastností se mezi verzemi NT8 můžou lišit.
            try
            {
                object list = nearest.MasterInstrument.GetType().GetProperty("RolloverCollection").GetValue(nearest.MasterInstrument);
                DateTime bestDate = DateTime.MinValue, bestMonth = DateTime.MinValue;
                foreach (object r in (System.Collections.IEnumerable)list)
                {
                    DateTime date = (DateTime)r.GetType().GetProperty("Date").GetValue(r);
                    DateTime month = (DateTime)r.GetType().GetProperty("ContractMonth").GetValue(r);
                    if (date <= at && date > bestDate) { bestDate = date; bestMonth = month; }
                }
                if (bestMonth > DateTime.MinValue)
                {
                    Instrument byRollover = Instrument.GetInstrument(root + " " + bestMonth.ToString("MM-yy", CultureInfo.InvariantCulture));
                    if (byRollover != null) return byRollover;
                }
            }
            catch { /* bez rolloverů zůstane nejbližší kontrakt */ }
            return nearest;
        }

        private static string NtTimeZoneId()
        {
            try { return NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo.Id; }
            catch { return TimeZoneInfo.Local.Id; }
        }

        // Cena, kterou jde poslat v JSONu. NaN nebo nekonečno by se zapsaly jako
        // holé NaN / Infinity, JSON by byl neplatný, aplikace by celou výstupní
        // exekuci odmítla a obchod by se do deníku nedostal. Sentinel
        // ±double.MaxValue (NT pohyb nesledoval) se odmítá taky.
        private static bool IsUsablePrice(double price)
        {
            return !double.IsNaN(price) && !double.IsInfinity(price) && Math.Abs(price) < 1e300;
        }

        private static async System.Threading.Tasks.Task PostJson(string json)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Post, ENDPOINT))
            {
                request.Headers.Add("X-FJ-API-Key", API_KEY);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
                HttpResponseMessage response = await Client.SendAsync(request);
                if (!response.IsSuccessStatusCode)
                    NinjaTrader.Code.Output.Process("FuturesJournalCapture HTTP " + (int)response.StatusCode, PrintTo.OutputTab1);
            }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
