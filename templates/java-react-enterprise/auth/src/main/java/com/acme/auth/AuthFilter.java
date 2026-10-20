package com.acme.auth;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.http.HttpCookie;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * Guards every routed request. It needs Basic credentials from users.yaml, a Bearer
 * token this gateway issued, or the gateway's {@code auth} cookie. A Basic login gets
 * a fresh token as the cookie. Upstream services always get the token as a Bearer
 * header. Anything else gets 401 with {@code WWW-Authenticate: Basic}.
 */
@Component
class AuthFilter implements GlobalFilter, Ordered {

    private final Map<String, AuthApplication.User> users;
    private final Tokens tokens;
    private final BCryptPasswordEncoder passwords = new BCryptPasswordEncoder();

    AuthFilter(AuthApplication.Settings settings, Tokens tokens) {
        this.users = settings.users().stream().collect(Collectors.toMap(AuthApplication.User::id, Function.identity()));
        this.tokens = tokens;
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        var token = token(exchange);
        if (token.isEmpty()) {
            var response = exchange.getResponse();
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            response.getHeaders().set(HttpHeaders.WWW_AUTHENTICATE, "Basic realm=\"acme\"");
            return response.setComplete();
        }
        var request = exchange.getRequest().mutate().headers(headers -> headers.setBearerAuth(token.get())).build();
        return chain.filter(exchange.mutate().request(request).build());
    }

    // Before the routing filters, which send the request upstream.
    @Override
    public int getOrder() {
        return 0;
    }

    private Optional<String> token(ServerWebExchange exchange) {
        var request = exchange.getRequest();
        var header = Objects.requireNonNullElse(request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION), "");
        if (header.startsWith("Basic ")) {
            var token = login(header.substring("Basic ".length()));
            token.ifPresent(value -> exchange.getResponse().addCookie(cookie(value)));
            return token;
        }
        if (header.startsWith("Bearer ")) {
            return Optional.of(header.substring("Bearer ".length())).filter(tokens::valid);
        }
        return Optional.ofNullable(request.getCookies().getFirst("auth")).map(HttpCookie::getValue).filter(tokens::valid);
    }

    private Optional<String> login(String basic) {
        String decoded;
        try {
            decoded = new String(Base64.getDecoder().decode(basic), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        var colon = decoded.indexOf(':');
        var user = colon < 0 ? null : users.get(decoded.substring(0, colon));
        if (user == null || !passwords.matches(decoded.substring(colon + 1), user.bcrypt())) {
            return Optional.empty();
        }
        return Optional.of(tokens.issue(user));
    }

    // Domain=localhost: the browser sends it to every port on localhost, the UI's 3000 included.
    private static ResponseCookie cookie(String token) {
        return ResponseCookie.from("auth", token)
                .domain("localhost")
                .path("/")
                .maxAge(Tokens.TTL)
                .httpOnly(true)
                .sameSite("Strict")
                .build();
    }
}
