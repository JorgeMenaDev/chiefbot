package com.acme.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpCookie;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

class AuthFilterTest {

    static final String SECRET = "a-test-secret-that-is-32-bytes-or-more";
    static final Instant NOW = Instant.parse("2026-01-01T09:00:00Z");
    static final AuthApplication.User ALICE = new AuthApplication.User(
            "alice", "Alice Example", new BCryptPasswordEncoder(4).encode("alice-password"), List.of("engineers"));

    final Tokens tokens = new Tokens(SECRET, Clock.fixed(NOW, ZoneOffset.UTC));
    final AuthFilter filter = new AuthFilter(new AuthApplication.Settings(SECRET, List.of(ALICE)), tokens);

    /** The request the gateway sent upstream, or null when it stopped at 401. */
    ServerWebExchange upstream;

    MockServerWebExchange send(MockServerHttpRequest.BaseBuilder<?> request) {
        var exchange = MockServerWebExchange.from(request);
        filter.filter(exchange, forwarded -> {
            upstream = forwarded;
            return Mono.empty();
        }).block();
        return exchange;
    }

    static String basic(String user, String password) {
        return "Basic " + Base64.getEncoder().encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8));
    }

    String forwardedToken() {
        var header = upstream.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        assertThat(header).startsWith("Bearer ");
        return header.substring("Bearer ".length());
    }

    @Test
    void basicLoginSetsTheAuthCookieAndForwardsABearerToken() {
        var exchange = send(MockServerHttpRequest.get("/acme-meta/v1/me")
                .header(HttpHeaders.AUTHORIZATION, basic("alice", "alice-password")));

        var token = forwardedToken();
        assertThat(tokens.valid(token)).isTrue();
        var cookie = exchange.getResponse().getCookies().getFirst("auth");
        assertThat(cookie.getValue()).isEqualTo(token);
        assertThat(cookie.getDomain()).isEqualTo("localhost");
        assertThat(cookie.getSameSite()).isEqualTo("Strict");
        assertThat(cookie.getMaxAge()).isEqualTo(Duration.ofHours(12));
        assertThat(cookie.isHttpOnly()).isTrue();
    }

    @Test
    void aWrongPasswordOrUnknownUserGets401() {
        assertUnauthorized(send(MockServerHttpRequest.get("/acme-meta/v1/me")
                .header(HttpHeaders.AUTHORIZATION, basic("alice", "wrong"))));
        assertUnauthorized(send(MockServerHttpRequest.get("/acme-meta/v1/me")
                .header(HttpHeaders.AUTHORIZATION, basic("mallory", "alice-password"))));
    }

    @Test
    void aBearerTokenGoesUpstreamAsItIs() {
        var token = tokens.issue(ALICE);
        var exchange = send(MockServerHttpRequest.get("/acme-meta/v1/records")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token));

        assertThat(forwardedToken()).isEqualTo(token);
        assertThat(exchange.getResponse().getCookies()).isEmpty();
    }

    @Test
    void theAuthCookieGoesUpstreamAsABearerToken() {
        var token = tokens.issue(ALICE);
        send(MockServerHttpRequest.get("/acme-ui/").cookie(new HttpCookie("auth", token)));

        assertThat(forwardedToken()).isEqualTo(token);
    }

    @Test
    void expiredOrForeignTokensGet401() {
        var expired = new Tokens(SECRET, Clock.fixed(NOW.minus(Duration.ofHours(13)), ZoneOffset.UTC)).issue(ALICE);
        var foreign = new Tokens("another-secret-that-is-32-bytes-or-more", Clock.fixed(NOW, ZoneOffset.UTC)).issue(ALICE);

        assertUnauthorized(send(MockServerHttpRequest.get("/acme-meta/v1/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + expired)));
        assertUnauthorized(send(MockServerHttpRequest.get("/acme-meta/v1/me").cookie(new HttpCookie("auth", foreign))));
    }

    @Test
    void noCredentialsGets401WithABasicChallenge() {
        assertUnauthorized(send(MockServerHttpRequest.get("/acme-ui/")));
    }

    void assertUnauthorized(MockServerWebExchange exchange) {
        assertThat(upstream).isNull();
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(exchange.getResponse().getHeaders().getFirst(HttpHeaders.WWW_AUTHENTICATE)).isEqualTo("Basic realm=\"acme\"");
    }
}
