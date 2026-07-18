// MyDAW — server/Sha1.h
// Header-only SHA-1 (FIPS 180-1) + Base64 encoder, used exclusively for the WebSocket
// handshake (Sec-WebSocket-Accept = base64(sha1(key + RFC6455 GUID))). Not for security
// purposes. Non-RT only (no allocation in Sha1 itself, but callers run on the server
// thread anyway).

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace mydaw {

class Sha1 {
public:
    static constexpr size_t kDigestSize = 20;

    Sha1() { reset(); }

    void reset() {
        h_[0] = 0x67452301u;
        h_[1] = 0xEFCDAB89u;
        h_[2] = 0x98BADCFEu;
        h_[3] = 0x10325476u;
        h_[4] = 0xC3D2E1F0u;
        totalBytes_ = 0;
        bufLen_ = 0;
    }

    void update(const void* data, size_t len) {
        const uint8_t* p = static_cast<const uint8_t*>(data);
        totalBytes_ += static_cast<uint64_t>(len);
        while (len > 0) {
            const size_t take = (len < (64 - bufLen_)) ? len : (64 - bufLen_);
            std::memcpy(buf_ + bufLen_, p, take);
            bufLen_ += take;
            p += take;
            len -= take;
            if (bufLen_ == 64) {
                processBlock(buf_);
                bufLen_ = 0;
            }
        }
    }

    void finish(uint8_t out[kDigestSize]) {
        const uint64_t bitLen = totalBytes_ * 8ull;
        const uint8_t one = 0x80;
        const uint8_t zero = 0x00;
        update(&one, 1);
        while (bufLen_ != 56)
            update(&zero, 1);
        uint8_t lenBytes[8];
        for (int i = 0; i < 8; ++i)
            lenBytes[i] = static_cast<uint8_t>((bitLen >> (56 - 8 * i)) & 0xFFu);
        update(lenBytes, 8); // totalBytes_ no longer matters; bitLen was captured above
        for (int i = 0; i < 5; ++i) {
            out[i * 4 + 0] = static_cast<uint8_t>((h_[i] >> 24) & 0xFFu);
            out[i * 4 + 1] = static_cast<uint8_t>((h_[i] >> 16) & 0xFFu);
            out[i * 4 + 2] = static_cast<uint8_t>((h_[i] >> 8) & 0xFFu);
            out[i * 4 + 3] = static_cast<uint8_t>(h_[i] & 0xFFu);
        }
    }

    // One-shot convenience.
    static void hash(const void* data, size_t len, uint8_t out[kDigestSize]) {
        Sha1 s;
        s.update(data, len);
        s.finish(out);
    }

private:
    static uint32_t rotl(uint32_t v, int bits) {
        return (v << bits) | (v >> (32 - bits));
    }

    void processBlock(const uint8_t block[64]) {
        uint32_t w[80];
        for (int i = 0; i < 16; ++i) {
            w[i] = (static_cast<uint32_t>(block[i * 4 + 0]) << 24) |
                   (static_cast<uint32_t>(block[i * 4 + 1]) << 16) |
                   (static_cast<uint32_t>(block[i * 4 + 2]) << 8) |
                   (static_cast<uint32_t>(block[i * 4 + 3]));
        }
        for (int i = 16; i < 80; ++i)
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

        uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4];
        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) {
                f = (b & c) | ((~b) & d);
                k = 0x5A827999u;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ED9EBA1u;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8F1BBCDCu;
            } else {
                f = b ^ c ^ d;
                k = 0xCA62C1D6u;
            }
            const uint32_t tmp = rotl(a, 5) + f + e + k + w[i];
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = tmp;
        }
        h_[0] += a;
        h_[1] += b;
        h_[2] += c;
        h_[3] += d;
        h_[4] += e;
    }

    uint32_t h_[5];
    uint64_t totalBytes_ = 0;
    uint8_t buf_[64];
    size_t bufLen_ = 0;
};

// Standard Base64 (RFC 4648, with padding). Used for Sec-WebSocket-Accept.
inline std::string base64Encode(const uint8_t* data, size_t len) {
    static const char kTable[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= len) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8) |
                           static_cast<uint32_t>(data[i + 2]);
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out.push_back(kTable[(v >> 6) & 0x3F]);
        out.push_back(kTable[v & 0x3F]);
        i += 3;
    }
    const size_t rem = len - i;
    if (rem == 1) {
        const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out.push_back('=');
        out.push_back('=');
    } else if (rem == 2) {
        const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                           (static_cast<uint32_t>(data[i + 1]) << 8);
        out.push_back(kTable[(v >> 18) & 0x3F]);
        out.push_back(kTable[(v >> 12) & 0x3F]);
        out.push_back(kTable[(v >> 6) & 0x3F]);
        out.push_back('=');
    }
    return out;
}

// Computes the RFC6455 Sec-WebSocket-Accept value for a client Sec-WebSocket-Key.
inline std::string webSocketAccept(std::string_view clientKey) {
    static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    Sha1 s;
    s.update(clientKey.data(), clientKey.size());
    s.update(kGuid, sizeof(kGuid) - 1);
    uint8_t digest[Sha1::kDigestSize];
    s.finish(digest);
    return base64Encode(digest, Sha1::kDigestSize);
}

} // namespace mydaw
