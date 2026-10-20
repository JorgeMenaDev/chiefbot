package com.acme.meta;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

/**
 * The API. Every endpoint takes the caller from the gateway's token. Records and
 * uploads pick a schema with {@code ?schema=} (live by default).
 */
@RestController
@RequestMapping("/acme-meta/v1")
class MetaController {

    private static final Set<String> SCHEMAS = Set.of("live", "sandbox", "experimental");

    private final JdbcClient db;

    MetaController(JdbcClient db) {
        this.db = db;
    }

    record Identity(String id, String name, List<String> groups) {}

    record Row(long id, String name, String note, String createdBy) {}

    record NewRow(String name, String note) {}

    record Upload(int inserted, int skipped) {}

    /** Who the token says the caller is. It also saves the caller's user row, which records need. */
    @GetMapping("/me")
    Identity me(@AuthenticationPrincipal Jwt jwt) {
        var me = new Identity(jwt.getSubject(), jwt.getClaimAsString("name"), jwt.getClaimAsStringList("groups"));
        db.sql("insert into live.users (id, name) values (?, ?) on conflict (id) do update set name = excluded.name")
                .params(me.id(), me.name())
                .update();
        return me;
    }

    @GetMapping("/records")
    List<Row> records(@RequestParam(defaultValue = "live") String schema) {
        return db.sql("select id, name, note, created_by from " + table(schema) + " order by id")
                .query(Row.class)
                .list();
    }

    @PostMapping("/records")
    @ResponseStatus(HttpStatus.CREATED)
    Row create(@RequestParam(defaultValue = "live") String schema, @RequestBody NewRow row,
            @AuthenticationPrincipal Jwt jwt) {
        return db.sql("insert into " + table(schema) + " (name, note, created_by) values (?, ?, ?)"
                        + " returning id, name, note, created_by")
                .params(row.name(), row.note() == null ? "" : row.note(), jwt.getSubject())
                .query(Row.class)
                .single();
    }

    /** Imports a CSV file with the header {@code name,note}. Names that exist are skipped, so the seed can run twice. */
    @PostMapping("/uploads")
    Upload upload(@RequestParam(defaultValue = "live") String schema, @RequestParam MultipartFile file,
            @AuthenticationPrincipal Jwt jwt) throws IOException {
        var rows = new String(file.getBytes(), StandardCharsets.UTF_8).lines().skip(1).filter(line -> !line.isBlank()).toList();
        var inserted = 0;
        for (var row : rows) {
            var cells = row.split(",", 2);
            inserted += db.sql("insert into " + table(schema) + " (name, note, created_by) values (?, ?, ?)"
                            + " on conflict (name) do nothing")
                    .params(cells[0].trim(), cells.length > 1 ? cells[1].trim() : "", jwt.getSubject())
                    .update();
        }
        return new Upload(inserted, rows.size() - inserted);
    }

    /** A taken name, or a caller without a user row (call /me first). */
    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<String> conflict(DataIntegrityViolationException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.getMostSpecificCause().getMessage());
    }

    // The schema goes into the SQL text, so only the three known names pass.
    private static String table(String schema) {
        if (!SCHEMAS.contains(schema)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "schema must be live, sandbox or experimental");
        }
        return schema + ".records";
    }
}
