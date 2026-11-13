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
// FJ_CONNECTOR_VERSION: 7
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
        // Verze 6: snímek trhu při vstupu (zpráva "market_snapshot", ticky
        // seance do vstupu) a objem na cenách u svíček dne.
        // Verze 7: živé ticky v paměti (jako graf) – snímek má ticky až do
        // vstupu, i když historie ticků od spojení končí dřív; svíčky snímku
        // z minutové historie, pokrytí ticky (ticksComplete / ticksUntil / ticksGap).
        private const string CONNECTOR_VERSION = "7";
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

                try { Connection.ConnectionStatusUpdate += OnConnectionStatusUpdate; } catch { }
                SendAllPositionSnapshots();
                PollWatchList();
                PollMarketRequests();
            }
            else if (State == State.Terminated)
            {
                try { Connection.ConnectionStatusUpdate -= OnConnectionStatusUpdate; } catch { }
                DropLiveExcept(new HashSet<string>());
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
            PollWatchList();
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
                // Po vstupu má aplikace případně požadavek na snímek trhu,
                // po výstupu na svíčky dne.
                PollMarketRequests();
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
                        // Sloupce: id, kořen, kontrakt, den, čas, typ, exekuce.
                        if (f.Length >= 7 && f[5] == "snapshot") await SendMarketSnapshot(f[0], f[1], f[2], f[3], f[4], f[6]);
                        else await SendMarketBars(f[0], f[1], f[2], f[3], f[4]);
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
            StringBuilder profile = new StringBuilder();
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
                                // Den bez seance (víkend, svátek): GetNextSession vrátí až další seanci.
                                if (sessionBegin > at || sessionEnd < at) error = "no_session_that_day";
                                else if (to <= sessionBegin) error = "session_not_started";
                                else
                                {
                                    error = await FetchMinuteBars(instrument, hours, sessionBegin, sessionEnd, to, bars);
                                    // Objem na cenách za seanci (pro VPOC / VAH / VAL předchozího
                                    // dne ve snímku). Selhání ticků = svíčky bez profilu.
                                    if (error == null)
                                    {
                                        DateTime sb = sessionBegin, se = sessionEnd;
                                        string tickError = await WithTicks(instrument, hours, sessionBegin, to, b =>
                                        {
                                            Dictionary<long, double> prof = new Dictionary<long, double>();
                                            double ts = instrument.MasterInstrument.TickSize;
                                            for (int i = 0; i < b.Count; i++)
                                            {
                                                DateTime t = b.GetTime(i);
                                                if (t <= sb || t > se) continue;
                                                AddVolume(prof, PriceKey(b.GetClose(i), ts), b.GetVolume(i));
                                            }
                                            if (prof.Count == 0) return "out_of_range";
                                            AppendProfile(profile, prof, ts);
                                            return null;
                                        });
                                        if (tickError != null) profile.Clear();
                                    }
                                }
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
                    : "\"bars\":[" + bars.ToString() + "]" + (profile.Length > 0 ? ",\"profile\":[" + profile.ToString() + "]" : "")) +
            "}";
            await PostJson(json);
        }

        // ---------------- Živé ticky (verze 7) ----------------
        // Graf v NT8 má ticky až do teď, protože si je ukládá, jak přicházejí.
        // Historie ticků od spojení (např. Tradovate) ale může končit o desítky
        // minut dřív – snímek z v6 pak bral starou svíčku. Konektor proto drží
        // v paměti živé ticky instrumentů, které mu řekne aplikace
        // (GET /api/v1/market/watch: kořen \t kontrakt), a snímek skládá
        // z historie do začátku živých ticků a z živých ticků od té chvíle.
        // Výpadek spojení buffer vynuluje (ticky z výpadku by jinak chyběly
        // bez varování) – díru pak snímek ohlásí v "ticksGap".
        private class LiveTicks
        {
            public Instrument Instrument;
            public MarketData Data;
            public EventHandler<MarketDataEventArgs> Handler;
            public DateTime Since = DateTime.MaxValue;   // od kdy buffer souvisle běží
            public readonly List<DateTime> Times = new List<DateTime>();
            public readonly List<double> Prices = new List<double>();
            public readonly List<double> Volumes = new List<double>();
            public readonly object Lock = new object();
        }
        private static readonly Dictionary<string, LiveTicks> liveTicks = new Dictionary<string, LiveTicks>();
        private static readonly object liveLock = new object();
        private static int watchPolling = 0;
        // Díra mezi koncem historie a prvním živým tickem kratší než tohle se
        // nebere jako výpadek (přechod historie → živé ticky trvá zlomky sekundy).
        private static readonly TimeSpan LIVE_JOIN = TimeSpan.FromSeconds(5);

        private async void PollWatchList()
        {
            if (!SEND_MARKET_BARS) return;
            if (System.Threading.Interlocked.Exchange(ref watchPolling, 1) == 1) return;
            try
            {
                string url = ENDPOINT.Replace("/api/v1/events", "/api/v1/market/watch");
                string text;
                using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    request.Headers.Add("X-FJ-API-Key", API_KEY);
                    request.Headers.Add("X-FJ-Connector-Version", CONNECTOR_VERSION);
                    HttpResponseMessage response = await Client.SendAsync(request);
                    // Starší aplikace adresu nezná (404) – nic se nemění.
                    if (!response.IsSuccessStatusCode) return;
                    text = await response.Content.ReadAsStringAsync();
                }
                var wanted = new HashSet<string>();
                foreach (string line in (text ?? "").Split('\n'))
                {
                    string[] f = line.TrimEnd('\r').Split('\t');
                    string root = f[0].Trim();
                    if (root.Length == 0) continue;
                    Instrument instrument = ResolveInstrument(f.Length > 1 ? f[1].Trim() : "", root, DateTime.Now);
                    if (instrument == null || string.IsNullOrEmpty(instrument.FullName)) continue;
                    wanted.Add(instrument.FullName);
                    EnsureLive(instrument);
                }
                DropLiveExcept(wanted);
            }
            catch (Exception ex)
            {
                NinjaTrader.Code.Output.Process("FuturesJournalCapture živé ticky: " + ex.Message, PrintTo.OutputTab1);
            }
            finally
            {
                System.Threading.Interlocked.Exchange(ref watchPolling, 0);
            }
        }

        private static void EnsureLive(Instrument instrument)
        {
            lock (liveLock)
            {
                if (liveTicks.ContainsKey(instrument.FullName)) return;
                LiveTicks lt = new LiveTicks { Instrument = instrument };
                lt.Handler = (sender, e) => AddLive(lt, e);
                lt.Data = new MarketData(instrument);
                lt.Data.Update += lt.Handler;
                liveTicks[instrument.FullName] = lt;
            }
        }

        private static void DropLiveExcept(HashSet<string> keep)
        {
            lock (liveLock)
            {
                foreach (string key in new List<string>(liveTicks.Keys))
                {
                    if (keep.Contains(key)) continue;
                    LiveTicks lt = liveTicks[key];
                    try { if (lt.Data != null) lt.Data.Update -= lt.Handler; } catch { }
                    liveTicks.Remove(key);
                }
            }
        }

        private static void ResetLive()
        {
            lock (liveLock)
            {
                foreach (LiveTicks lt in liveTicks.Values)
                    lock (lt.Lock) { lt.Times.Clear(); lt.Prices.Clear(); lt.Volumes.Clear(); lt.Since = DateTime.MaxValue; }
            }
        }

        private void OnConnectionStatusUpdate(object sender, ConnectionStatusEventArgs e)
        {
            if (e.PriceStatus == ConnectionStatus.Disconnected || e.PriceStatus == ConnectionStatus.ConnectionLost) ResetLive();
        }

        private static void AddLive(LiveTicks lt, MarketDataEventArgs e)
        {
            if (e.MarketDataType != MarketDataType.Last || !IsUsablePrice(e.Price) || e.Volume <= 0) return;
            lock (lt.Lock)
            {
                DateTime t = e.Time;
                if (lt.Since == DateTime.MaxValue) lt.Since = t;
                lt.Times.Add(t);
                lt.Prices.Add(e.Price);
                lt.Volumes.Add(e.Volume);
                // Paměť: drží se jen posledních 36 hodin.
                if (lt.Times.Count % 20000 == 0)
                {
                    DateTime keepFrom = t.AddHours(-36);
                    int n = lt.Times.FindIndex(x => x >= keepFrom);
                    if (n < 0) n = lt.Times.Count;
                    if (n > 0)
                    {
                        lt.Times.RemoveRange(0, n); lt.Prices.RemoveRange(0, n); lt.Volumes.RemoveRange(0, n);
                        if (lt.Since < keepFrom) lt.Since = keepFrom;
                    }
                }
            }
        }

        // Živé ticky (from, to] instrumentu do seznamů. Vrací, od kdy buffer
        // souvisle běží; DateTime.MaxValue = živé ticky nejsou (nesleduje se,
        // nebo začaly až po `to`).
        private static DateTime LiveSlice(Instrument instrument, DateTime from, DateTime to, List<DateTime> times, List<double> prices, List<double> volumes)
        {
            LiveTicks lt;
            lock (liveLock) { if (instrument == null || !liveTicks.TryGetValue(instrument.FullName ?? "", out lt)) return DateTime.MaxValue; }
            lock (lt.Lock)
            {
                if (lt.Since > to) return DateTime.MaxValue;
                for (int i = 0; i < lt.Times.Count; i++)
                {
                    DateTime t = lt.Times[i];
                    if (t <= from || t > to) continue;
                    times.Add(t); prices.Add(lt.Prices[i]); volumes.Add(lt.Volumes[i]);
                }
                return lt.Since;
            }
        }

        // ---------------- Snímek trhu při vstupu (verze 7) ----------------
        // Do času vstupu (nic po vstupu se nepočítá):
        //  - 1min svíčky OHLCV z minutové historie (ta je aktuální i tam, kde
        //    historie ticků končí dřív); delta a VPOC z ticků jen u svíček, které
        //    ticky pokrývají celé, jinak null (nezměřeno),
        //  - delta = tick rule: obchod výš než předchozí = nákup, níž = prodej,
        //    stejná cena = směr předchozího; směr se přenáší přes celou seanci
        //    (stejně jako LTA footprint, ověřeno 9/9 svíček – docs/SNAPSHOT_DISCOVERY.md),
        //  - 30min svíčky z ticků (jen celé pokryté), VPOC = cena s největším
        //    objemem (při shodě všechny), test VPOC = cena po uzavření svíčky,
        //  - profil dne z ticků, high / low a VWAP z minutových svíček.
        // Pokrytí: ticksUntil (kam ticky sahají), ticksComplete, ticksGap
        // [od, do] = díra mezi historií a živými ticky. VAH / VAL z profilu počítá
        // aplikace (jedno pravidlo pro dnešek i včerejšek).
        private const int SNAPSHOT_BARS_1M = 25;

        private class BarAgg
        {
            public DateTime End;
            public double O = double.NaN, H = double.MinValue, L = double.MaxValue, C, V, Delta;
            public Dictionary<long, double> Profile = new Dictionary<long, double>();
            public void Add(double p, double v, int dir, long key)
            {
                if (double.IsNaN(O)) O = p;
                if (p > H) H = p;
                if (p < L) L = p;
                C = p; V += v; Delta += dir * v;
                AddVolume(Profile, key, v);
            }
        }

        private class MinBar
        {
            public DateTime End;
            public double O, H, L, C, V;
        }

        private async System.Threading.Tasks.Task SendMarketSnapshot(string id, string root, string full, string day, string timeIso, string executionId)
        {
            string error = null;
            string instrumentFull = full ?? "";
            string hoursName = "";
            StringBuilder body = new StringBuilder();
            try
            {
                DateTime entryUtc;
                if (!DateTime.TryParse(timeIso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out entryUtc))
                    error = "bad_time";
                else
                {
                    DateTime entry = DateTime.SpecifyKind(entryUtc, DateTimeKind.Utc).ToLocalTime();
                    Instrument instrument = ResolveInstrument(full, root, entry);
                    TradingHours hours = instrument == null ? null : (!string.IsNullOrEmpty(MARKET_TRADING_HOURS)
                        ? TradingHours.Get(MARKET_TRADING_HOURS)
                        : (instrument.MasterInstrument != null ? instrument.MasterInstrument.TradingHours : null));
                    SessionIterator sessions = hours == null ? null : new SessionIterator(hours);
                    if (instrument == null) error = "instrument_not_found";
                    else if (hours == null) error = "no_trading_hours";
                    else if (!sessions.GetNextSession(entry, true) || sessions.ActualSessionBegin > entry) error = "no_session";
                    else
                    {
                        instrumentFull = instrument.FullName ?? "";
                        hoursName = hours.Name ?? "";
                        DateTime sessionBegin = sessions.ActualSessionBegin;
                        DateTime sessionEnd = sessions.ActualSessionEnd;
                        double ts = instrument.MasterInstrument.TickSize;

                        var minutes = new List<MinBar>();
                        string minuteError = await FetchMinuteList(instrument, hours, sessionBegin, sessionEnd, entry, minutes);
                        if (minuteError != null) minutes = null;

                        var hTimes = new List<DateTime>(); var hPrices = new List<double>(); var hVolumes = new List<double>();
                        string tickError = await WithTicks(instrument, hours, sessionBegin, entry.AddSeconds(1), b =>
                        {
                            for (int i = 0; i < b.Count; i++)
                            {
                                DateTime t = b.GetTime(i);
                                if (t <= sessionBegin || t > entry) continue;
                                double p = b.GetClose(i);
                                if (!IsUsablePrice(p)) continue;
                                hTimes.Add(t); hPrices.Add(p); hVolumes.Add(b.GetVolume(i));
                            }
                            return null;
                        });
                        if (tickError != null) { hTimes.Clear(); hPrices.Clear(); hVolumes.Clear(); }

                        var lTimes = new List<DateTime>(); var lPrices = new List<double>(); var lVolumes = new List<double>();
                        DateTime liveSince = LiveSlice(instrument, sessionBegin, entry, lTimes, lPrices, lVolumes);

                        error = BuildSnapshot(sessionBegin, entry, ts, minutes, hTimes, hPrices, hVolumes, liveSince, lTimes, lPrices, lVolumes, body);
                    }
                }
            }
            catch (Exception ex)
            {
                error = "error: " + ex.Message;
            }

            string json = "{" +
                "\"source\":\"ninjatrader\"," +
                "\"type\":\"market_snapshot\"," +
                "\"requestId\":\"" + Escape(id) + "\"," +
                "\"executionId\":\"" + Escape(executionId) + "\"," +
                "\"root\":\"" + Escape(root) + "\"," +
                "\"instrumentFull\":\"" + Escape(instrumentFull) + "\"," +
                // Datum obchodu; klíč "day" nese hodnoty dne (profil, high / low, VWAP).
                "\"tradeDay\":\"" + Escape(day) + "\"," +
                "\"time\":\"" + Escape(timeIso) + "\"," +
                "\"tradingHours\":\"" + Escape(hoursName) + "\"," +
                "\"timeZone\":\"" + Escape(NtTimeZoneId()) + "\"," +
                (error != null
                    ? "\"error\":\"" + Escape(error.Replace("\r", " ").Replace("\n", " ")) + "\""
                    : body.ToString()) +
            "}";
            await PostJson(json);
        }

        // Z minutových svíček a ticků (sessionBegin, entry] postaví části snímku
        // do `body` (bez složených závorek). Vrací null, nebo kód chyby.
        private static string BuildSnapshot(DateTime sessionBegin, DateTime entry, double ts, List<MinBar> minuteSeries,
            List<DateTime> hTimes, List<double> hPrices, List<double> hVolumes,
            DateTime liveSince, List<DateTime> lTimes, List<double> lPrices, List<double> lVolumes, StringBuilder body)
        {
            bool hasLive = liveSince != DateTime.MaxValue;
            // Ticky: historie do začátku živých ticků, pak živé.
            var times = new List<DateTime>(); var prices = new List<double>(); var volumes = new List<double>();
            DateTime histEnd = sessionBegin;
            for (int i = 0; i < hTimes.Count; i++)
            {
                if (hTimes[i] > histEnd) histEnd = hTimes[i];
                if (hasLive && hTimes[i] >= liveSince) continue;
                times.Add(hTimes[i]); prices.Add(hPrices[i]); volumes.Add(hVolumes[i]);
            }
            if (hasLive) { times.AddRange(lTimes); prices.AddRange(lPrices); volumes.AddRange(lVolumes); }

            // Pokrytí ticky: s živými ticky až do vstupu; díra = historie skončila
            // dřív, než živé ticky začaly.
            DateTime coveredEnd = hasLive ? entry : histEnd;
            bool hasGap = hasLive && liveSince - histEnd > LIVE_JOIN;
            DateTime gapFrom = hasGap ? histEnd : DateTime.MinValue, gapTo = hasGap ? liveSince : DateTime.MinValue;
            Func<DateTime, DateTime, bool> covered = (barStart, barEnd) =>
                barStart >= sessionBegin && barEnd <= coveredEnd && !(hasGap && barStart < gapTo && barEnd > gapFrom);

            var tickMinutes = new Dictionary<DateTime, BarAgg>();
            var tickMinuteList = new List<BarAgg>();
            var halves = new List<BarAgg>();
            var dayProfile = new Dictionary<long, double>();
            double lastPrice = double.NaN;
            int lastDirection = 0;
            for (int i = 0; i < times.Count; i++)
            {
                DateTime t = times[i];
                double p = prices[i], v = volumes[i];
                if (!double.IsNaN(lastPrice)) { if (p > lastPrice) lastDirection = 1; else if (p < lastPrice) lastDirection = -1; }
                lastPrice = p;
                long key = PriceKey(p, ts);
                DateTime mEnd = CeilTo(t, sessionBegin, 1);
                BarAgg m;
                if (!tickMinutes.TryGetValue(mEnd, out m)) { m = new BarAgg { End = mEnd }; tickMinutes[mEnd] = m; tickMinuteList.Add(m); }
                m.Add(p, v, lastDirection, key);
                DateTime hEnd = CeilTo(t, sessionBegin, 30);
                if (halves.Count == 0 || halves[halves.Count - 1].End != hEnd) halves.Add(new BarAgg { End = hEnd });
                halves[halves.Count - 1].Add(p, v, lastDirection, key);
                AddVolume(dayProfile, key, v);
            }

            // Minutové svíčky: z minutové historie; bez ní z ticků (jen pokryté).
            var bars = new List<MinBar>();
            if (minuteSeries != null)
                foreach (MinBar b in minuteSeries) { if (b.End <= entry) bars.Add(b); }
            else
                foreach (BarAgg a in tickMinuteList)
                    if (a.End <= entry && covered(a.End.AddMinutes(-1), a.End)) bars.Add(new MinBar { End = a.End, O = a.O, H = a.H, L = a.L, C = a.C, V = a.V });
            if (bars.Count == 0 && times.Count == 0) return "empty";

            // Rozsah cen po čase X do vstupu: minutové svíčky + ticky v minutě vstupu.
            DateTime entryFloor = CeilTo(entry, sessionBegin, 1) == entry ? entry : CeilTo(entry, sessionBegin, 1).AddMinutes(-1);
            Func<DateTime, double[]> rangeAfter = from =>
            {
                double lo = double.MaxValue, hi = double.MinValue;
                foreach (MinBar b in bars) if (b.End.AddMinutes(-1) >= from) { if (b.L < lo) lo = b.L; if (b.H > hi) hi = b.H; }
                for (int i = 0; i < times.Count; i++) if (times[i] > from && times[i] > entryFloor) { if (prices[i] < lo) lo = prices[i]; if (prices[i] > hi) hi = prices[i]; }
                return new[] { lo, hi };
            };

            double high = double.MinValue, low = double.MaxValue, pv = 0, vol = 0;
            foreach (MinBar b in bars) { if (b.H > high) high = b.H; if (b.L < low) low = b.L; pv += (b.H + b.L + b.C) / 3.0 * b.V; vol += b.V; }
            for (int i = 0; i < times.Count; i++) if (times[i] > entryFloor) { if (prices[i] > high) high = prices[i]; if (prices[i] < low) low = prices[i]; }

            body.Append("\"bars1m\":[");
            int start = Math.Max(0, bars.Count - SNAPSHOT_BARS_1M);
            for (int i = start; i < bars.Count; i++)
            {
                MinBar m = bars[i];
                BarAgg a;
                bool measured = tickMinutes.TryGetValue(m.End, out a) && covered(m.End.AddMinutes(-1), m.End);
                if (i > start) body.Append(",");
                body.Append("[\"").Append(m.End.ToUniversalTime().ToString("o")).Append("\",")
                    .Append(Num(m.O)).Append(",").Append(Num(m.H)).Append(",").Append(Num(m.L)).Append(",").Append(Num(m.C)).Append(",")
                    .Append(Num(m.V)).Append(",");
                if (measured) body.Append(Num(a.Delta)).Append(",[").Append(VpocList(a.Profile, ts, null, null, null)).Append("]]");
                else body.Append("null,null]");
            }
            body.Append("],\"bars30m\":[");
            bool firstHalf = true;
            foreach (BarAgg h in halves)
            {
                if (h.End > entry || !covered(h.End.AddMinutes(-30), h.End)) continue;
                double[] r = rangeAfter(h.End);
                var tested = new StringBuilder();
                string vpocs = VpocList(h.Profile, ts, tested, r[0], r[1]);
                if (!firstHalf) body.Append(",");
                firstHalf = false;
                body.Append("[\"").Append(h.End.ToUniversalTime().ToString("o")).Append("\",")
                    .Append(Num(h.O)).Append(",").Append(Num(h.H)).Append(",").Append(Num(h.L)).Append(",").Append(Num(h.C)).Append(",")
                    .Append(Num(h.V)).Append(",[").Append(vpocs).Append("],[").Append(tested.ToString()).Append("]]");
            }
            var profile = new StringBuilder();
            AppendProfile(profile, dayProfile, ts);
            body.Append("],\"day\":{\"profile\":[").Append(profile.ToString()).Append("],")
                .Append("\"high\":").Append(Num(high)).Append(",\"low\":").Append(Num(low))
                .Append(vol > 0 ? ",\"vwap\":" + Num(pv / vol) : "").Append("},");
            bool complete = !hasGap && times.Count > 0 && coveredEnd >= entryFloor;
            body.Append("\"ticksComplete\":").Append(complete ? "true" : "false")
                .Append(",\"ticksUntil\":\"").Append((times.Count > 0 ? coveredEnd : sessionBegin).ToUniversalTime().ToString("o")).Append("\"");
            if (hasGap) body.Append(",\"ticksGap\":[\"").Append(gapFrom.ToUniversalTime().ToString("o")).Append("\",\"").Append(gapTo.ToUniversalTime().ToString("o")).Append("\"]");
            if (hasLive) body.Append(",\"liveSince\":\"").Append(liveSince.ToUniversalTime().ToString("o")).Append("\"");
            return null;
        }

        // VPOC (všechny ceny s největším objemem). S `tested` zapíše ke každé,
        // jestli leží v rozsahu cen po uzavření svíčky [min, max].
        private static string VpocList(Dictionary<long, double> profile, double ts, StringBuilder tested, double? min, double? max)
        {
            double best = -1;
            foreach (var kv in profile) if (kv.Value > best) best = kv.Value;
            var keys = new List<long>();
            foreach (var kv in profile) if (kv.Value == best) keys.Add(kv.Key);
            keys.Sort();
            var sb = new StringBuilder();
            for (int i = 0; i < keys.Count; i++)
            {
                double p = keys[i] * ts;
                if (i > 0) { sb.Append(","); if (tested != null) tested.Append(","); }
                sb.Append(Num(p));
                if (tested != null) tested.Append(min.HasValue && max.HasValue && min.Value <= p && p <= max.Value ? "true" : "false");
            }
            return sb.ToString();
        }

        // Konec svíčky, do které čas patří: (konec − délka, konec], zarovnáno od začátku seance.
        private static DateTime CeilTo(DateTime t, DateTime sessionBegin, int minutes)
        {
            long span = TimeSpan.FromMinutes(minutes).Ticks;
            long since = (t - sessionBegin).Ticks;
            long periods = since / span + (since % span > 0 ? 1 : 0);
            return sessionBegin.AddTicks(periods * span);
        }

        private static long PriceKey(double price, double tickSize) { return (long)Math.Round(price / tickSize); }

        private static void AddVolume(Dictionary<long, double> profile, long key, double v)
        {
            double cur;
            profile[key] = profile.TryGetValue(key, out cur) ? cur + v : v;
        }

        private static void AppendProfile(StringBuilder sb, Dictionary<long, double> profile, double ts)
        {
            var keys = new List<long>(profile.Keys);
            keys.Sort();
            for (int i = 0; i < keys.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("[").Append(Num(keys[i] * ts)).Append(",").Append(Num(profile[keys[i]])).Append("]");
            }
        }

        private static string Num(double v)
        {
            return IsUsablePrice(v) ? Math.Round(v, 8).ToString(CultureInfo.InvariantCulture) : "null";
        }

        // Ticky (from, to] instrumentu; `work` je zpracuje a vrátí null, nebo kód chyby.
        private static async System.Threading.Tasks.Task<string> WithTicks(Instrument instrument, TradingHours hours, DateTime from, DateTime to, Func<Bars, string> work)
        {
            var tcs = new System.Threading.Tasks.TaskCompletionSource<string>();
            BarsRequest request = new BarsRequest(instrument, from, to);
            request.BarsPeriod = new BarsPeriod { BarsPeriodType = BarsPeriodType.Tick, Value = 1 };
            request.TradingHours = hours;
            try
            {
                request.Request((req, code, message) =>
                {
                    try
                    {
                        if (code != ErrorCode.NoError || req.Bars == null) { tcs.TrySetResult("data: " + code + " " + message); return; }
                        tcs.TrySetResult(work(req.Bars));
                    }
                    catch (Exception ex) { tcs.TrySetResult("error: " + ex.Message); }
                });
                var finished = await System.Threading.Tasks.Task.WhenAny(tcs.Task, System.Threading.Tasks.Task.Delay(180000));
                return finished == tcs.Task ? tcs.Task.Result : "timeout";
            }
            finally
            {
                request.Dispose();
            }
        }

        // Stáhne 1min svíčky (from, to] a zapíše jen ty, které končí uvnitř
        // seance (sessionBegin, sessionEnd]. Vrací null, nebo kód chyby.
        private static async System.Threading.Tasks.Task<string> FetchMinuteBars(Instrument instrument, TradingHours hours, DateTime sessionBegin, DateTime sessionEnd, DateTime to, StringBuilder bars)
        {
            var list = new List<MinBar>();
            string error = await FetchMinuteList(instrument, hours, sessionBegin, sessionEnd, to, list);
            if (error != null) return error;
            for (int i = 0; i < list.Count; i++)
            {
                MinBar m = list[i];
                if (i > 0) bars.Append(",");
                bars.Append("[\"").Append(m.End.ToUniversalTime().ToString("o")).Append("\",")
                    .Append(m.O.ToString(CultureInfo.InvariantCulture)).Append(",")
                    .Append(m.H.ToString(CultureInfo.InvariantCulture)).Append(",")
                    .Append(m.L.ToString(CultureInfo.InvariantCulture)).Append(",")
                    .Append(m.C.ToString(CultureInfo.InvariantCulture)).Append(",")
                    .Append(m.V.ToString(CultureInfo.InvariantCulture)).Append("]");
            }
            return null;
        }

        // 1min svíčky (sessionBegin, to + 1 min] do seznamu, jen ty, které končí
        // uvnitř seance (sessionBegin, sessionEnd]. Vrací null, nebo kód chyby.
        private static async System.Threading.Tasks.Task<string> FetchMinuteList(Instrument instrument, TradingHours hours, DateTime sessionBegin, DateTime sessionEnd, DateTime to, List<MinBar> list)
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
                            list.Add(new MinBar { End = t, O = o, H = h, L = l, C = c, V = b.GetVolume(i) });
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
