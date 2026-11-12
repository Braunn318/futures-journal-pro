#region Using declarations
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
#endregion

// Futures Journal PRO – TESTOVACÍ add-on pro NinjaTrader 8 (průzkum J0,
// Claude files/ZADANI_DENIK_SNAPSHOT_TRHU.md, výsledek do docs/SNAPSHOT_DISCOVERY.md).
//
// JEN ČTE. Nezadává příkazy, nečte obchodní účty, nic neposílá do deníku ani
// jinam po síti. Jen stáhne historická data přes BarsRequest a výsledek zapíše
// do Documents\NinjaTrader 8\FJSnapshotProbe\probe-<čas>.json + NinjaScript Output.
// Spouští se ručně: Control Center → New → „FJ Snapshot Probe – spustit".
// Po průzkumu soubor smaž z bin\Custom\AddOns a stiskni F5.
//
// Ověřuje:
//  1) BarsRequest 1 tick pro MES / ES: objem na ceně, bid / ask u ticku (delta),
//     kolik dní zpět data jsou, jak dlouho trvá jedna seance, paměť a CPU NT8.
//  2) Totéž při připojení Playback (Market Replay): vrací data přehrávaného dne,
//     jsou úplná (počet minut proti šabloně seance, mezery), nevrací i svíčky
//     po aktuálním čase přehrávání (pohled do budoucnosti)?
//  3) VPOC svíčky spočítaný z ticků (1min a 30min) pro zadané časy – k porovnání
//     s LTA footprintem na fotkách.

namespace NinjaTrader.NinjaScript.AddOns
{
    public class FJSnapshotProbe : AddOnBase
    {
        // ---------------- Nastavení (uprav před F5) ----------------
        // Kontrakty k měření (přesný název z Instruments, aktuální front month).
        private static readonly string[] INSTRUMENTS = { "MES 12-26", "ES 12-26" };
        // Kolik obchodních dní zpět zkusit (každý = jedna celá seance, zvlášť).
        private static readonly int[] DAYS_BACK = { 1, 5, 20, 60, 120 };
        // Šablona seance; prázdné = Trading Hours instrumentu (jako konektor).
        private const string TRADING_HOURS = "";
        // Časy konce svíček pro otázku 3, v časovém pásmu NT8, formát "yyyy-MM-dd HH:mm".
        // Čas = konec svíčky, jak ho ukazuje NT (1min svíčka 15:31 = 15:30–15:31).
        // 30min svíčka se spočítá pro tu, která daný čas obsahuje.
        // Výchozí = svíčky ES 1M z fotky docs/snapshot/screen.png (12. 11. 2026, 12:31–12:39).
        private static readonly string[] CHECK_BARS = {
            "2026-11-12 12:31", "2026-11-12 12:32", "2026-11-12 12:33", "2026-11-12 12:34", "2026-11-12 12:35",
            "2026-11-12 12:36", "2026-11-12 12:37", "2026-11-12 12:38", "2026-11-12 12:39" };
        // Instrument pro otázku 3 (svíčky z fotky).
        private const string CHECK_INSTRUMENT = "ES 12-26";
        // Limit na jeden BarsRequest.
        private const int REQUEST_TIMEOUT_SEC = 240;
        // Kolik cenových úrovní profilu vypsat u kontrolní svíčky (0 = všechny).
        private const int PROFILE_LEVELS = 0;
        // ------------------------------------------------------------

        private NTMenuItem newMenu;
        private NTMenuItem probeItem;
        private static bool running;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "FJSnapshotProbe";
                Description = "Futures Journal PRO – průzkum dat trhu (jen čtení)";
            }
        }

        protected override void OnWindowCreated(Window window)
        {
            ControlCenter cc = window as ControlCenter;
            if (cc == null) return;
            newMenu = cc.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null) return;
            probeItem = new NTMenuItem
            {
                Header = "FJ Snapshot Probe – spustit",
                Style = Application.Current.TryFindResource("MainMenuItem") as Style
            };
            probeItem.Click += OnProbeClick;
            newMenu.Items.Add(probeItem);
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (!(window is ControlCenter) || probeItem == null) return;
            probeItem.Click -= OnProbeClick;
            if (newMenu != null && newMenu.Items.Contains(probeItem)) newMenu.Items.Remove(probeItem);
            probeItem = null;
        }

        private void OnProbeClick(object sender, RoutedEventArgs e)
        {
            if (running) { Log("Probe už běží, počkej na konec."); return; }
            running = true;
            Task.Run(async () =>
            {
                try { await RunProbe(); }
                catch (Exception ex) { Log("CHYBA: " + ex); }
                finally { running = false; }
            });
        }

        // ================= průběh =================

        private async Task RunProbe()
        {
            Log("Start průzkumu (jen čtení) …");
            var root = new J();
            root.Set("probe", "FJSnapshotProbe 2");
            root.Set("startedLocal", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            root.Set("ntTimeZone", NtTimeZone());

            // Q2: připojení + čas Playbacku
            DateTime? playbackNow;
            root.Set("connections", Connections(out playbackNow));
            root.Set("playbackNow", playbackNow.HasValue ? Ts(playbackNow.Value) : null);
            DateTime refTime = playbackNow ?? DateTime.Now;
            root.Set("referenceTime", Ts(refTime));
            Log(playbackNow.HasValue ? "Playback připojen, čas přehrávání " + Ts(playbackNow.Value) : "Playback nepřipojen – měřím živá historická data.");

            var instruments = new List<object>();
            foreach (string name in INSTRUMENTS)
            {
                Instrument instrument = Instrument.GetInstrument(name);
                var ij = new J();
                ij.Set("name", name);
                if (instrument == null) { ij.Set("error", "instrument nenalezen"); instruments.Add(ij); continue; }
                TradingHours hours = Hours(instrument);
                ij.Set("tradingHours", hours != null ? hours.Name : null);
                ij.Set("tickSize", instrument.MasterInstrument.TickSize);
                if (hours == null) { ij.Set("error", "bez šablony seance"); instruments.Add(ij); continue; }

                // Q1: celé seance N dní zpět
                var days = new List<object>();
                foreach (int back in DAYS_BACK)
                {
                    DateTime day = TradingDayBack(refTime.Date, back);
                    DateTime sBegin, sEnd;
                    if (!SessionFor(hours, day.AddHours(12), out sBegin, out sEnd)) { days.Add(new J().Set("daysBack", back).Set("error", "seance nenalezena")); continue; }
                    Log(name + ": seance " + back + " dní zpět (" + Ts(sBegin) + " – " + Ts(sEnd) + ") …");
                    var dj = new J().Set("daysBack", back).Set("sessionBegin", Ts(sBegin)).Set("sessionEnd", Ts(sEnd));
                    dj.Set("ticks", await MeasureTicks(instrument, hours, sBegin, sEnd, null));
                    dj.Set("minute", await MeasureMinutes(instrument, hours, sBegin, sEnd, null));
                    days.Add(dj);
                }
                ij.Set("sessionsBack", days);

                // Q2: seance referenčního dne (Playback = přehrávaný den) do referenčního času
                DateTime cBegin, cEnd;
                if (SessionFor(hours, refTime, out cBegin, out cEnd) && cBegin <= refTime)
                {
                    Log(name + ": aktuální seance do " + Ts(refTime) + " …");
                    var cj = new J().Set("sessionBegin", Ts(cBegin)).Set("sessionEnd", Ts(cEnd)).Set("upTo", Ts(refTime));
                    // Žádá se o celou seanci, aby bylo vidět, jestli Playback vrátí i svíčky po svém čase.
                    cj.Set("ticks", await MeasureTicks(instrument, hours, cBegin, cEnd, refTime));
                    cj.Set("minute", await MeasureMinutes(instrument, hours, cBegin, cEnd, refTime));
                    ij.Set("currentSession", cj);
                }
                else ij.Set("currentSession", new J().Set("error", "referenční čas není v seanci"));
                instruments.Add(ij);
            }
            root.Set("instruments", instruments);

            // Q3: kontrolní svíčky
            root.Set("checkBars", await CheckBars());

            root.Set("finishedLocal", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            string dir = Path.Combine(NinjaTrader.Core.Globals.UserDataDir, "FJSnapshotProbe");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "probe-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
            File.WriteAllText(file, root.ToJson(0), new UTF8Encoding(false));
            Log("Hotovo. Výsledek: " + file);
        }

        // ================= měření =================

        private class Fetch { public Bars Bars; public string Error; public long Ms; public long MemBefore, MemAfter, WsBefore, WsAfter; public double CpuMs; public BarsRequest Req; }

        private async Task<Fetch> Request(Instrument instrument, TradingHours hours, DateTime from, DateTime to, BarsPeriodType type, int value)
        {
            var f = new Fetch();
            Process proc = Process.GetCurrentProcess();
            GC.Collect(); GC.WaitForPendingFinalizers();
            f.MemBefore = GC.GetTotalMemory(true);
            proc.Refresh(); f.WsBefore = proc.WorkingSet64;
            TimeSpan cpu0 = proc.TotalProcessorTime;
            var sw = Stopwatch.StartNew();
            var tcs = new TaskCompletionSource<bool>();
            BarsRequest req = new BarsRequest(instrument, from, to);
            req.BarsPeriod = new BarsPeriod { BarsPeriodType = type, Value = value };
            req.TradingHours = hours;
            f.Req = req;
            req.Request((r, code, message) =>
            {
                if (code != ErrorCode.NoError || r.Bars == null) f.Error = code + " " + message;
                else f.Bars = r.Bars;
                tcs.TrySetResult(true);
            });
            Task done = await Task.WhenAny(tcs.Task, Task.Delay(REQUEST_TIMEOUT_SEC * 1000));
            sw.Stop();
            f.Ms = sw.ElapsedMilliseconds;
            if (done != tcs.Task) f.Error = "timeout " + REQUEST_TIMEOUT_SEC + " s";
            proc.Refresh();
            f.WsAfter = proc.WorkingSet64;
            f.MemAfter = GC.GetTotalMemory(false);
            f.CpuMs = (proc.TotalProcessorTime - cpu0).TotalMilliseconds;
            return f;
        }

        private static J Load(Fetch f)
        {
            return new J().Set("ms", f.Ms).Set("cpuMs", Math.Round(f.CpuMs))
                .Set("managedMemDeltaMB", Math.Round((f.MemAfter - f.MemBefore) / 1048576.0, 1))
                .Set("workingSetDeltaMB", Math.Round((f.WsAfter - f.WsBefore) / 1048576.0, 1))
                .Set("workingSetAfterMB", Math.Round(f.WsAfter / 1048576.0, 1));
        }

        private async Task<J> MeasureTicks(Instrument instrument, TradingHours hours, DateTime from, DateTime to, DateTime? upTo)
        {
            Fetch f = await Request(instrument, hours, from, to, BarsPeriodType.Tick, 1);
            J j = Load(f);
            try
            {
                if (f.Error != null) { j.Set("error", f.Error); return j; }
                Bars b = f.Bars;
                double ts = instrument.MasterInstrument.TickSize;
                long count = b.Count, withBidAsk = 0, atAsk = 0, atBid = 0, between = 0, afterUpTo = 0;
                double vol = 0, buyVol = 0, sellVol = 0, unkVol = 0;
                var levels = new HashSet<long>();
                for (int i = 0; i < b.Count; i++)
                {
                    double p = b.GetClose(i), v = b.GetVolume(i);
                    vol += v;
                    levels.Add(Key(p, ts));
                    if (upTo.HasValue && b.GetTime(i) > upTo.Value) afterUpTo++;
                    double ask = b.GetAsk(i), bid = b.GetBid(i);
                    if (ask > 0 && bid > 0 && ask >= bid && ask < 1e300 && bid < 1e300)
                    {
                        withBidAsk++;
                        if (p >= ask) { atAsk++; buyVol += v; }
                        else if (p <= bid) { atBid++; sellVol += v; }
                        else { between++; unkVol += v; }
                    }
                    else unkVol += v;
                }
                j.Set("count", count).Set("volume", vol).Set("priceLevels", levels.Count)
                 .Set("firstTime", count > 0 ? Ts(b.GetTime(0)) : null)
                 .Set("lastTime", count > 0 ? Ts(b.GetTime(b.Count - 1)) : null)
                 .Set("withBidAsk", withBidAsk).Set("atAsk", atAsk).Set("atBid", atBid).Set("between", between)
                 .Set("buyVolume", buyVol).Set("sellVolume", sellVol).Set("unclassifiedVolume", unkVol)
                 .Set("delta", buyVol - sellVol);
                if (count > 0)
                {
                    var sample = new List<object>();
                    for (int i = 0; i < Math.Min(5, b.Count); i++)
                        sample.Add(new J().Set("t", Ts(b.GetTime(i))).Set("p", b.GetClose(i)).Set("v", (double)b.GetVolume(i)).Set("bid", b.GetBid(i)).Set("ask", b.GetAsk(i)));
                    j.Set("sample", sample);
                }
                if (upTo.HasValue) j.Set("ticksAfterReferenceTime", afterUpTo);

            }
            finally { if (f.Req != null) f.Req.Dispose(); }
            return j;
        }

        private async Task<J> MeasureMinutes(Instrument instrument, TradingHours hours, DateTime from, DateTime to, DateTime? upTo)
        {
            Fetch f = await Request(instrument, hours, from, to, BarsPeriodType.Minute, 1);
            J j = Load(f);
            try
            {
                if (f.Error != null) { j.Set("error", f.Error); return j; }
                Bars b = f.Bars;
                DateTime limit = upTo.HasValue && upTo.Value < to ? upTo.Value : to;
                double expected = Math.Max(0, (limit - from).TotalMinutes);
                long afterUpTo = 0; double vol = 0;
                var gaps = new List<object>();
                DateTime prev = from;
                for (int i = 0; i < b.Count; i++)
                {
                    DateTime t = b.GetTime(i);
                    vol += b.GetVolume(i);
                    if (upTo.HasValue && t > upTo.Value) afterUpTo++;
                    if ((t - prev).TotalMinutes > 1.01 && gaps.Count < 30) gaps.Add(new J().Set("from", Ts(prev)).Set("to", Ts(t)).Set("minutes", Math.Round((t - prev).TotalMinutes)));
                    prev = t;
                }
                j.Set("count", (long)b.Count).Set("expectedMinutes", Math.Round(expected)).Set("volume", vol)
                 .Set("firstTime", b.Count > 0 ? Ts(b.GetTime(0)) : null)
                 .Set("lastTime", b.Count > 0 ? Ts(b.GetTime(b.Count - 1)) : null)
                 .Set("gapsOver1min", gaps);
                if (upTo.HasValue) j.Set("barsAfterReferenceTime", afterUpTo);
            }
            finally { if (f.Req != null) f.Req.Dispose(); }
            return j;
        }

        // Q3: 1min a 30min svíčka z ticků + srovnání s 1min svíčkou NT
        private async Task<List<object>> CheckBars()
        {
            var result = new List<object>();
            if (CHECK_BARS.Length == 0) { Log("CHECK_BARS je prázdné – otázka 3 se přeskakuje."); return result; }
            Instrument instrument = Instrument.GetInstrument(CHECK_INSTRUMENT);
            if (instrument == null) { result.Add(new J().Set("error", "instrument " + CHECK_INSTRUMENT + " nenalezen")); return result; }
            TradingHours hours = Hours(instrument);
            double ts = instrument.MasterInstrument.TickSize;

            var bySession = new Dictionary<DateTime, List<DateTime>>();
            var sessionEnds = new Dictionary<DateTime, DateTime>();
            foreach (string s in CHECK_BARS)
            {
                DateTime t;
                if (!DateTime.TryParseExact(s, "yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out t)) { result.Add(new J().Set("input", s).Set("error", "špatný formát")); continue; }
                DateTime b, e;
                if (hours == null || !SessionFor(hours, t.AddSeconds(-1), out b, out e) || b >= t) { result.Add(new J().Set("input", s).Set("error", "čas není v seanci")); continue; }
                if (!bySession.ContainsKey(b)) { bySession[b] = new List<DateTime>(); sessionEnds[b] = e; }
                bySession[b].Add(t);
            }

            foreach (var kv in bySession)
            {
                DateTime sBegin = kv.Key, sEnd = sessionEnds[kv.Key];
                Log(CHECK_INSTRUMENT + ": kontrolní svíčky v seanci " + Ts(sBegin) + " …");
                Fetch ft = await Request(instrument, hours, sBegin, sEnd, BarsPeriodType.Tick, 1);
                Fetch fm = await Request(instrument, hours, sBegin, sEnd, BarsPeriodType.Minute, 1);
                try
                {
                    foreach (DateTime end in kv.Value)
                    {
                        var cj = new J().Set("barEnd", Ts(end));
                        if (ft.Error != null) { cj.Set("error", "ticky: " + ft.Error); result.Add(cj); continue; }
                        cj.Set("bar1m", BarFromTicks(ft.Bars, end.AddMinutes(-1), end, ts));
                        // 30min svíčka zarovnaná na začátek seance (jako NT)
                        double sinceBegin = (end - sBegin).TotalMinutes;
                        DateTime end30 = sBegin.AddMinutes(Math.Ceiling(sinceBegin / 30.0) * 30);
                        DateTime start30 = end30.AddMinutes(-30);
                        cj.Set("bar30m", BarFromTicks(ft.Bars, start30, end30, ts).Set("start", Ts(start30)).Set("end", Ts(end30)));
                        if (fm.Error == null)
                        {
                            for (int i = 0; i < fm.Bars.Count; i++)
                                if (fm.Bars.GetTime(i) == end)
                                {
                                    cj.Set("ntMinuteBar", new J().Set("o", fm.Bars.GetOpen(i)).Set("h", fm.Bars.GetHigh(i)).Set("l", fm.Bars.GetLow(i)).Set("c", fm.Bars.GetClose(i)).Set("v", (double)fm.Bars.GetVolume(i)));
                                    break;
                                }
                        }
                        result.Add(cj);
                    }
                }
                finally
                {
                    if (ft.Req != null) ft.Req.Dispose();
                    if (fm.Req != null) fm.Req.Dispose();
                }
            }
            return result;
        }

        // Svíčka (from, to] z ticků: OHLCV, VPOC (všechny ceny se shodným maximem), delta, profil.
        private static J BarFromTicks(Bars b, DateTime from, DateTime to, double ts)
        {
            double o = 0, h = double.MinValue, l = double.MaxValue, c = 0, vol = 0, buy = 0, sell = 0;
            int n = 0;
            var prof = new SortedDictionary<long, double[]>(); // [objem, ask, bid]
            double dPrev = 0, dPrevUnk = 0, dNext = 0, dNextUnk = 0, dTick = 0;
            int lastDir = 0;
            var raw = new List<object>();
            for (int i = 0; i < b.Count; i++)
            {
                DateTime t = b.GetTime(i);
                if (t <= from) continue;
                if (t > to) break;
                double p = b.GetClose(i), v = b.GetVolume(i);
                if (n == 0) o = p;
                n++; c = p; h = Math.Max(h, p); l = Math.Min(l, p); vol += v;
                long k = Key(p, ts);
                double[] cell;
                if (!prof.TryGetValue(k, out cell)) { cell = new double[3]; prof[k] = cell; }
                cell[0] += v;
                double ask = b.GetAsk(i), bid = b.GetBid(i);
                if (ask > 0 && bid > 0 && ask >= bid && ask < 1e300)
                {
                    if (p >= ask) { cell[1] += v; buy += v; }
                    else if (p <= bid) { cell[2] += v; sell += v; }
                }
                // Další pravidla zařazení (verze 2 probe): bid / ask předchozího a dalšího ticku, tick rule.
                if (i > 0)
                {
                    double pa = b.GetAsk(i - 1), pbid = b.GetBid(i - 1), pp = b.GetClose(i - 1);
                    if (p >= pa) dPrev += v; else if (p <= pbid) dPrev -= v; else dPrevUnk += v;
                    if (p > pp) lastDir = 1; else if (p < pp) lastDir = -1;
                    dTick += lastDir * v;
                }
                if (i + 1 < b.Count)
                {
                    double na = b.GetAsk(i + 1), nb = b.GetBid(i + 1);
                    if (p >= na) dNext += v; else if (p <= nb) dNext -= v; else dNextUnk += v;
                }
                if (raw.Count < 2000) raw.Add(new J().Set("t", t.ToString("HH:mm:ss.fff")).Set("p", p).Set("v", v).Set("bid", bid).Set("ask", ask));
            }
            var j = new J().Set("ticks", n);
            if (n == 0) return j.Set("error", "žádné ticky");
            double max = prof.Values.Max(x => x[0]);
            var vpoc = prof.Where(x => x.Value[0] == max).Select(x => (object)Math.Round(x.Key * ts, 6)).ToList();
            j.Set("o", o).Set("h", h).Set("l", l).Set("c", c).Set("v", vol)
             .Set("vpoc", vpoc).Set("vpocVolume", max).Set("delta", buy - sell).Set("askVolume", buy).Set("bidVolume", sell);
            var levels = new List<object>();
            foreach (var kv in prof.Reverse())
            {
                if (PROFILE_LEVELS > 0 && levels.Count >= PROFILE_LEVELS) break;
                levels.Add(new J().Set("p", Math.Round(kv.Key * ts, 6)).Set("v", kv.Value[0]).Set("ask", kv.Value[1]).Set("bid", kv.Value[2]));
            }
            j.Set("profile", levels);
            j.Set("deltaRules", new J().Set("sameTickQuote", buy - sell).Set("prevTickQuote", dPrev).Set("prevTickQuoteUnclassified", dPrevUnk)
                .Set("nextTickQuote", dNext).Set("nextTickQuoteUnclassified", dNextUnk).Set("tickRule", dTick));
            j.Set("rawTicks", raw);
            return j;
        }

        // ================= pomocné =================

        private static long Key(double price, double tickSize) { return (long)Math.Round(price / tickSize); }

        private static TradingHours Hours(Instrument instrument)
        {
            if (!string.IsNullOrEmpty(TRADING_HOURS)) return TradingHours.Get(TRADING_HOURS);
            return instrument.MasterInstrument != null ? instrument.MasterInstrument.TradingHours : null;
        }

        private static bool SessionFor(TradingHours hours, DateTime t, out DateTime begin, out DateTime end)
        {
            begin = end = DateTime.MinValue;
            var it = new SessionIterator(hours);
            if (!it.GetNextSession(t, true)) return false;
            begin = it.ActualSessionBegin; end = it.ActualSessionEnd;
            return true;
        }

        private static DateTime TradingDayBack(DateTime from, int back)
        {
            DateTime d = from;
            int left = back;
            while (left > 0)
            {
                d = d.AddDays(-1);
                if (d.DayOfWeek != DayOfWeek.Saturday && d.DayOfWeek != DayOfWeek.Sunday) left--;
            }
            return d;
        }

        // Připojení a čas Playbacku. Přes reflexi, aby se soubor přeložil
        // i v NT8 verzi, kde se vlastnosti jmenují jinak.
        private static List<object> Connections(out DateTime? playbackNow)
        {
            playbackNow = null;
            var list = new List<object>();
            try
            {
                foreach (Connection c in Connection.Connections.ToList())
                {
                    object opts = c.Options;
                    string optType = opts != null ? opts.GetType().Name : null;
                    bool playback = optType != null && optType.IndexOf("Playback", StringComparison.OrdinalIgnoreCase) >= 0;
                    var j = new J().Set("name", opts != null ? Prop(opts, "Name") : null).Set("optionsType", optType)
                        .Set("status", c.Status.ToString()).Set("isPlayback", playback);
                    if (playback)
                    {
                        object now = Prop(c, "Now");
                        if (now is DateTime) { playbackNow = (DateTime)now; j.Set("now", Ts((DateTime)now)); }
                    }
                    list.Add(j);
                }
                if (!playbackNow.HasValue)
                {
                    PropertyInfo pi = typeof(Connection).GetProperty("PlaybackConnection", BindingFlags.Public | BindingFlags.Static);
                    object pc = pi != null ? pi.GetValue(null) : null;
                    if (pc != null)
                    {
                        object now = Prop(pc, "Now");
                        if (now is DateTime) playbackNow = (DateTime)now;
                    }
                }
            }
            catch (Exception ex) { list.Add(new J().Set("error", ex.Message)); }
            return list;
        }

        private static object Prop(object o, string name)
        {
            try
            {
                PropertyInfo pi = o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                return pi != null ? pi.GetValue(o) : null;
            }
            catch { return null; }
        }

        private static string NtTimeZone()
        {
            try { return NinjaTrader.Core.Globals.GeneralOptions.TimeZoneInfo.Id; }
            catch { return TimeZoneInfo.Local.Id; }
        }

        private static string Ts(DateTime t) { return t.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture); }

        private static void Log(string s) { NinjaTrader.Code.Output.Process("FJSnapshotProbe: " + s, PrintTo.OutputTab1); }

        // Minimální JSON (pořadí klíčů zachované).
        private class J
        {
            private readonly List<KeyValuePair<string, object>> items = new List<KeyValuePair<string, object>>();
            public J Set(string k, object v) { items.Add(new KeyValuePair<string, object>(k, v)); return this; }
            public string ToJson(int ind)
            {
                var sb = new StringBuilder();
                Write(sb, this, ind);
                return sb.ToString();
            }
            private static void Write(StringBuilder sb, object v, int ind)
            {
                string pad = new string(' ', ind * 2), pad1 = new string(' ', (ind + 1) * 2);
                if (v == null) sb.Append("null");
                else if (v is J)
                {
                    var it = ((J)v).items;
                    if (it.Count == 0) { sb.Append("{}"); return; }
                    sb.Append("{\n");
                    for (int i = 0; i < it.Count; i++)
                    {
                        sb.Append(pad1).Append('"').Append(Esc(it[i].Key)).Append("\": ");
                        Write(sb, it[i].Value, ind + 1);
                        sb.Append(i < it.Count - 1 ? ",\n" : "\n");
                    }
                    sb.Append(pad).Append('}');
                }
                else if (v is System.Collections.IEnumerable && !(v is string))
                {
                    var arr = ((System.Collections.IEnumerable)v).Cast<object>().ToList();
                    if (arr.Count == 0) { sb.Append("[]"); return; }
                    sb.Append("[\n");
                    for (int i = 0; i < arr.Count; i++)
                    {
                        sb.Append(pad1);
                        Write(sb, arr[i], ind + 1);
                        sb.Append(i < arr.Count - 1 ? ",\n" : "\n");
                    }
                    sb.Append(pad).Append(']');
                }
                else if (v is bool) sb.Append((bool)v ? "true" : "false");
                else if (v is double || v is float)
                {
                    double d = Convert.ToDouble(v);
                    if (double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) >= 1e300) sb.Append("null");
                    else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                }
                else if (v is int || v is long) sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture));
                else sb.Append('"').Append(Esc(v.ToString())).Append('"');
            }
            private static string Esc(string s)
            {
                var sb = new StringBuilder();
                foreach (char ch in s ?? "")
                {
                    if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                    else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                }
                return sb.ToString();
            }
        }
    }
}
