/*
 * Runs tests/jdbc-parity/corpus.json through the official CUBRID JDBC driver
 * and writes normalized JSON results for compare.ts. Java 11+ single-file
 * launch, no build step:
 *
 *   java -Duser.timezone=UTC -cp cubrid-jdbc.jar tests/jdbc-parity/JdbcRunner.java \
 *     corpus.json out.json 127.0.0.1 33000 testdb
 *
 * Values are normalized exactly as ts-runner.ts does; see the comments there.
 * Keep the two runners in step.
 */

import java.io.Reader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

public class JdbcRunner {
  private static final DateTimeFormatter DATETIME =
      DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss.SSS");
  private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss");

  public static void main(String[] args) throws Exception {
    if (args.length != 5) {
      System.err.println("usage: JdbcRunner <corpus.json> <out.json> <host> <port> <database>");
      System.exit(2);
    }
    if (!"UTC".equals(java.util.TimeZone.getDefault().getID())) {
      throw new IllegalStateException("Run with -Duser.timezone=UTC");
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> corpus =
        (Map<String, Object>) new Json(Files.readString(Path.of(args[0]))).parse();
    String base = "jdbc:cubrid:" + args[2] + ":" + args[3] + ":" + args[4] + ":dba::?charset=";
    String url = base + "utf-8";
    Class.forName("cubrid.jdbc.driver.CUBRIDDriver");

    Map<String, Object> out = new LinkedHashMap<>();
    out.put("runner", "jdbc");
    List<Object> results = new ArrayList<>();
    try (Connection a = DriverManager.getConnection(url);
        Connection b = DriverManager.getConnection(url)) {
      DatabaseMetaData md = a.getMetaData();
      out.put("driverVersion", md.getDriverVersion());
      out.put("serverVersion", md.getDatabaseProductVersion());
      out.put("runtime", "Java " + System.getProperty("java.version") + " "
          + System.getProperty("java.vm.name"));
      @SuppressWarnings("unchecked")
      List<Object> cases = (List<Object>) corpus.get("cases");
      for (Object c : cases) {
        @SuppressWarnings("unchecked")
        Map<String, Object> testCase = (Map<String, Object>) c;
        long started = System.nanoTime();
        Object charset = testCase.get("charset");
        if (charset == null || testCase.containsKey("unverified")) {
          results.add(runCase(testCase, a, b));
        } else {
          // Its own pair of connections, so the charset applies to this case only.
          try (Connection ca = DriverManager.getConnection(base + charset);
              Connection cb = DriverManager.getConnection(base + charset)) {
            results.add(runCase(testCase, ca, cb));
          } catch (SQLException e) {
            Map<String, Object> failed = new LinkedHashMap<>();
            failed.put("id", testCase.get("id"));
            failed.put("status", "failed");
            failed.put("failure", e.toString());
            results.add(failed);
          }
        }
        System.err.printf("jdbc %-40s %6d ms%n", testCase.get("id"), (System.nanoTime() - started) / 1000000);
      }
    }
    out.put("cases", results);
    Files.writeString(Path.of(args[1]), Json.write(out) + "\n");
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> runCase(Map<String, Object> c, Connection a, Connection b) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("id", c.get("id"));
    if (c.containsKey("unverified")) {
      result.put("status", "skipped");
      return result;
    }
    List<Object> steps = new ArrayList<>();
    try {
      for (Object sql : (List<Object>) c.getOrDefault("setup", List.of())) {
        try (Statement st = a.createStatement()) {
          st.execute((String) sql);
        }
      }
      for (Object s : (List<Object>) c.get("steps")) {
        Map<String, Object> step = (Map<String, Object>) s;
        Connection conn = "b".equals(step.get("conn")) ? b : a;
        steps.add(runStep(step, conn));
      }
      result.put("status", "ran");
      result.put("steps", steps);
    } catch (Exception e) {
      result.put("status", "failed");
      result.put("failure", e.toString());
      result.put("steps", steps);
    } finally {
      try {
        if (!a.getAutoCommit()) {
          a.rollback();
          a.setAutoCommit(true);
        }
      } catch (SQLException ignored) {
        // The next case reports a broken connection itself.
      }
      for (Object sql : (List<Object>) c.getOrDefault("cleanup", List.of())) {
        try (Statement st = a.createStatement()) {
          st.execute((String) sql);
        } catch (SQLException ignored) {
          // Cleanup is best effort; setup of a later run drops nothing it needs.
        }
      }
    }
    return result;
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> runStep(Map<String, Object> step, Connection conn) throws Exception {
    String op = (String) step.get("op");
    String sql = (String) step.get("sql");
    boolean digest = Boolean.TRUE.equals(step.get("digest"));
    List<Object> params = (List<Object>) step.getOrDefault("params", List.of());
    Map<String, Object> out = new LinkedHashMap<>();
    try {
      switch (op) {
        case "version":
          out.put("version", conn.getMetaData().getDatabaseProductVersion());
          break;
        case "begin":
          conn.setAutoCommit(false);
          out.put("ok", true);
          break;
        case "commit":
          conn.commit();
          conn.setAutoCommit(true);
          out.put("ok", true);
          break;
        case "rollback":
          conn.rollback();
          conn.setAutoCommit(true);
          out.put("ok", true);
          break;
        case "exec":
          try (Statement st = conn.createStatement()) {
            out.put("affected", (long) st.executeUpdate(sql));
          }
          break;
        case "query":
          try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            readRows(rs, out, digest);
          }
          break;
        case "execPrepared":
          try (PreparedStatement ps = conn.prepareStatement(sql)) {
            bind(ps, params);
            out.put("affected", (long) ps.executeUpdate());
          }
          break;
        case "queryPrepared":
          try (PreparedStatement ps = conn.prepareStatement(sql)) {
            bind(ps, params);
            try (ResultSet rs = ps.executeQuery()) {
              readRows(rs, out, digest);
            }
          }
          break;
        default:
          throw new IllegalArgumentException("unknown op " + op);
      }
    } catch (SQLException e) {
      out.clear();
      out.put("error", (long) e.getErrorCode());
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  static void bind(PreparedStatement ps, List<Object> params) throws SQLException {
    for (int i = 0; i < params.size(); i++) {
      Map<String, Object> p = (Map<String, Object>) params.get(i);
      Object v = p.get("v");
      int at = i + 1;
      switch ((String) p.get("t")) {
        case "int":
          ps.setInt(at, ((Number) v).intValue());
          break;
        case "bigint":
          ps.setLong(at, Long.parseLong((String) v));
          break;
        case "double":
          ps.setDouble(at, ((Number) v).doubleValue());
          break;
        case "string":
          ps.setString(at, (String) v);
          break;
        case "null":
          ps.setNull(at, Types.NULL);
          break;
        case "datetime":
          ps.setTimestamp(at, Timestamp.valueOf(LocalDateTime.parse((String) v, DATETIME)));
          break;
        case "bytes":
          ps.setBytes(at, hexToBytes((String) v));
          break;
        default:
          throw new IllegalArgumentException("unknown param type " + p.get("t"));
      }
    }
  }

  static void readRows(ResultSet rs, Map<String, Object> out, boolean digest) throws Exception {
    ResultSetMetaData md = rs.getMetaData();
    int n = md.getColumnCount();
    List<Object> columns = new ArrayList<>();
    for (int i = 1; i <= n; i++) columns.add(md.getColumnLabel(i).toLowerCase());
    out.put("columns", columns);
    List<Object> rows = new ArrayList<>();
    List<Object> reps = new ArrayList<>();
    List<TreeSet<String>> digestReps = new ArrayList<>();
    for (int i = 0; i < n; i++) digestReps.add(new TreeSet<>());
    MessageDigest sha = MessageDigest.getInstance("SHA-256");
    long count = 0;
    while (rs.next()) {
      List<Object> row = new ArrayList<>();
      List<Object> rowReps = new ArrayList<>();
      for (int i = 1; i <= n; i++) {
        Object value = rs.getObject(i);
        row.add(normalize(value));
        rowReps.add(rep(value));
        if (digest) digestReps.get(i - 1).add(Json.write(rep(value)));
      }
      count++;
      if (digest) {
        sha.update((Json.write(row) + "\n").getBytes(StandardCharsets.UTF_8));
      } else {
        rows.add(row);
        reps.add(rowReps);
      }
    }
    if (digest) {
      out.put("count", count);
      out.put("sha256", hex(sha.digest()));
      List<Object> columnReps = new ArrayList<>();
      for (TreeSet<String> set : digestReps) columnReps.add(new ArrayList<Object>(set));
      out.put("columnReps", columnReps);
    } else {
      out.put("rows", rows);
      out.put("reps", reps);
    }
  }

  /** The value the comparison sees: text, null, or a list for a collection. */
  static Object normalize(Object v) throws SQLException {
    if (v == null) return null;
    if (v instanceof Short || v instanceof Integer || v instanceof Long) return v.toString();
    if (v instanceof Float) return normalizeDouble(((Float) v).doubleValue());
    if (v instanceof Double) return normalizeDouble((Double) v);
    if (v instanceof BigDecimal) return ((BigDecimal) v).toPlainString();
    if (v instanceof String) return v;
    if (v instanceof byte[]) return "0x" + hex((byte[]) v);
    if (v instanceof java.sql.Date) return ((java.sql.Date) v).toLocalDate().toString();
    if (v instanceof Time) return ((Time) v).toLocalTime().format(TIME);
    if (v instanceof Timestamp) return ((Timestamp) v).toLocalDateTime().format(DATETIME);
    if (v instanceof Blob) {
      Blob blob = (Blob) v;
      return "0x" + hex(blob.getBytes(1, (int) blob.length()));
    }
    if (v instanceof Clob) {
      Clob clob = (Clob) v;
      StringBuilder sb = new StringBuilder();
      try (Reader r = clob.getCharacterStream()) {
        char[] buf = new char[8192];
        int read;
        while ((read = r.read(buf)) > 0) sb.append(buf, 0, read);
      } catch (java.io.IOException e) {
        throw new SQLException(e);
      }
      return sb.toString();
    }
    if (v instanceof Object[]) {
      List<Object> list = new ArrayList<>();
      for (Object e : (Object[]) v) list.add(normalize(e));
      return list;
    }
    return "unhandled:" + v.getClass().getName();
  }

  /** Integral doubles as integer text, every other double as its exact IEEE-754 bits. */
  static String normalizeDouble(double d) {
    if (Double.isFinite(d) && d == Math.rint(d) && Math.abs(d) <= 9007199254740991.0) {
      return Long.toString((long) d);
    }
    return "f64:" + String.format("%016x", Double.doubleToRawLongBits(d));
  }

  /** The Java class that carried the value, for the representation tables. */
  static Object rep(Object v) {
    if (v == null) return "null";
    if (v instanceof Object[]) {
      List<Object> list = new ArrayList<>();
      list.add("Object[]");
      for (Object e : (Object[]) v) list.add(rep(e));
      return list;
    }
    return v.getClass().getSimpleName();
  }

  static String hex(byte[] bytes) {
    StringBuilder sb = new StringBuilder();
    for (byte x : bytes) sb.append(String.format("%02x", x));
    return sb.toString();
  }

  static byte[] hexToBytes(String s) {
    byte[] out = new byte[s.length() / 2];
    for (int i = 0; i < out.length; i++) {
      out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  /** Minimal JSON reader and a writer whose output matches JavaScript's JSON.stringify. */
  static final class Json {
    private final String s;
    private int i;

    Json(String s) {
      this.s = s;
    }

    Object parse() {
      Object v = value();
      ws();
      if (i != s.length()) throw new IllegalArgumentException("trailing JSON at " + i);
      return v;
    }

    private void ws() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private Object value() {
      ws();
      char c = s.charAt(i);
      if (c == '{') {
        i++;
        Map<String, Object> m = new LinkedHashMap<>();
        ws();
        if (s.charAt(i) == '}') {
          i++;
          return m;
        }
        while (true) {
          ws();
          String k = string();
          ws();
          expect(':');
          m.put(k, value());
          ws();
          if (s.charAt(i) == ',') {
            i++;
            continue;
          }
          expect('}');
          return m;
        }
      }
      if (c == '[') {
        i++;
        List<Object> l = new ArrayList<>();
        ws();
        if (s.charAt(i) == ']') {
          i++;
          return l;
        }
        while (true) {
          l.add(value());
          ws();
          if (s.charAt(i) == ',') {
            i++;
            continue;
          }
          expect(']');
          return l;
        }
      }
      if (c == '"') return string();
      if (s.startsWith("true", i)) {
        i += 4;
        return Boolean.TRUE;
      }
      if (s.startsWith("false", i)) {
        i += 5;
        return Boolean.FALSE;
      }
      if (s.startsWith("null", i)) {
        i += 4;
        return null;
      }
      int start = i;
      while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      String num = s.substring(start, i);
      if (num.isEmpty()) throw new IllegalArgumentException("bad JSON at " + start);
      if (num.matches("-?\\d+")) return Long.parseLong(num);
      return Double.parseDouble(num);
    }

    private void expect(char c) {
      if (s.charAt(i) != c) throw new IllegalArgumentException("expected " + c + " at " + i);
      i++;
    }

    private String string() {
      expect('"');
      StringBuilder sb = new StringBuilder();
      while (true) {
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c != '\\') {
          sb.append(c);
          continue;
        }
        char e = s.charAt(i++);
        switch (e) {
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'n': sb.append('\n'); break;
          case 'r': sb.append('\r'); break;
          case 't': sb.append('\t'); break;
          case 'u':
            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
            break;
          default: sb.append(e);
        }
      }
    }

    @SuppressWarnings("unchecked")
    static String write(Object v) {
      if (v == null) return "null";
      if (v instanceof Boolean || v instanceof Long || v instanceof Integer) return v.toString();
      if (v instanceof String) return quote((String) v);
      if (v instanceof List) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (Object e : (List<Object>) v) {
          if (!first) sb.append(',');
          first = false;
          sb.append(write(e));
        }
        return sb.append(']').toString();
      }
      if (v instanceof Map) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
          if (!first) sb.append(',');
          first = false;
          sb.append(quote(e.getKey())).append(':').append(write(e.getValue()));
        }
        return sb.append('}').toString();
      }
      throw new IllegalArgumentException("cannot write " + v.getClass());
    }

    static String quote(String s) {
      StringBuilder sb = new StringBuilder("\"");
      for (int k = 0; k < s.length(); k++) {
        char c = s.charAt(k);
        switch (c) {
          case '"': sb.append("\\\""); break;
          case '\\': sb.append("\\\\"); break;
          case '\b': sb.append("\\b"); break;
          case '\f': sb.append("\\f"); break;
          case '\n': sb.append("\\n"); break;
          case '\r': sb.append("\\r"); break;
          case '\t': sb.append("\\t"); break;
          default:
            if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
      }
      return sb.append('"').toString();
    }
  }
}
