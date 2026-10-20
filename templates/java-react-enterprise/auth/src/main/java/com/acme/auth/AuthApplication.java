package com.acme.auth;

import java.time.Clock;
import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.Bean;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.reactive.CorsWebFilter;
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource;

@SpringBootApplication
@ConfigurationPropertiesScan
public class AuthApplication {

    /** {@code acme.jwt-secret} from application.yml, {@code acme.users} from users.yaml. */
    @ConfigurationProperties("acme")
    public record Settings(String jwtSecret, List<User> users) {}

    public record User(String id, String name, String bcrypt, List<String> groups) {}

    public static void main(String[] args) {
        SpringApplication.run(AuthApplication.class, args);
    }

    @Bean
    Tokens tokens(Settings settings) {
        return new Tokens(settings.jwtSecret(), Clock.systemUTC());
    }

    // Only the UI's dev origin may call the gateway from a browser. Hard-coded on
    // purpose, as real gateways often are: the UI cannot simply move to another port.
    @Bean
    CorsWebFilter cors() {
        var config = new CorsConfiguration();
        config.addAllowedOrigin("http://localhost:3000");
        config.setAllowedMethods(List.of("GET", "POST"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
        config.setAllowCredentials(true);
        var source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return new CorsWebFilter(source);
    }
}
