package com.acme.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.time.Clock;
import java.time.Duration;
import java.util.Date;

/** The gateway's HS256 tokens: the user's id, display name and groups, valid for 12 hours. */
class Tokens {

    static final Duration TTL = Duration.ofHours(12);

    private final MACSigner signer;
    private final MACVerifier verifier;
    private final Clock clock;

    Tokens(String secret, Clock clock) {
        var key = secret.getBytes(StandardCharsets.UTF_8);
        try {
            this.signer = new MACSigner(key);
            this.verifier = new MACVerifier(key);
        } catch (JOSEException e) {
            throw new IllegalArgumentException("acme.jwt-secret must be at least 32 bytes", e);
        }
        this.clock = clock;
    }

    String issue(AuthApplication.User user) {
        var now = clock.instant();
        var claims = new JWTClaimsSet.Builder()
                .subject(user.id())
                .claim("name", user.name())
                .claim("groups", user.groups())
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plus(TTL)))
                .build();
        var jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        try {
            jwt.sign(signer);
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
        return jwt.serialize();
    }

    /** True for an HS256 token signed with this secret that has not expired. */
    boolean valid(String token) {
        try {
            var jwt = SignedJWT.parse(token);
            var expiry = jwt.getJWTClaimsSet().getExpirationTime();
            return JWSAlgorithm.HS256.equals(jwt.getHeader().getAlgorithm())
                    && jwt.verify(verifier)
                    && expiry != null
                    && clock.instant().isBefore(expiry.toInstant());
        } catch (ParseException | JOSEException e) {
            return false;
        }
    }
}
