import crypto from "node:crypto";

const cookie = "VISITOR_INFO1_LIVE=DTIG-Z46fhI; VISITOR_PRIVACY_METADATA=CgJJThIEGgAgGg%3D%3D; _gcl_au=1.1.1572519284.1783620587; YSC=Zwb2wJ3IkJI; LOGIN_INFO=AFmmF2swRQIhAKTu9f7BPmiDj7ii2BPXcTJoHXUJz_1EqlJkXLSwxCScAiABhVSxw_MlNltP6seTb4NSuhoGFiocwJdtJyUPaiLCZg:QUQ3MjNmeE9YbU55aVN4T29LSFlMcUFwaU5sem04U3RoVEY2RDhYVDh1SXV5RS04TVlXdWo1LUZaM2I0MkpPTC1KNmM3bnF0bTFxdDZBTG9kUUI0VWVkWXFRWUpyeWRQRWNVaGIzR2JId29kT2lkR2ljUDRQT19CMGZubW5tNzZFbnBLbThHNlZRSVl5WVNYVUYyOEpFN056bVRtMjgtclZ3; HSID=AtsxZhv4DV6ifjGaS; SSID=AkKPr5OOv9I8k5Nph; APISID=TWI5cGWIoKzg3qGj/ABWzS7tBaFsU80Kao; SAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-1PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-3PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; SID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYz58PC5wij0UefSc6Wc5akwACgYKAc4SARUSFQHGX2MiQKThy3VzxcAiwsN40uue5hoVAUF8yKonRJaWNtHG4882SGRMlsMJ0076; __Secure-1PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYnVhQ015ZXmLcXVtfHJIE3gACgYKAdMSARUSFQHGX2MiayHeX2SRtCBbXKT20oAcWxoVAUF8yKp6cSKyLj8ZcIc5azYMcUrc0076; __Secure-3PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYvuQ9Qw5Fj9_x31qJvt9ZxgACgYKAXISARUSFQHGX2MiDbupJahxU4INHCBPv6JYSxoVAUF8yKoCrAYpbLs88p_Qx3d-mQKM0076; PREF=tz=Asia.Calcutta&f7=100&repeat=NONE&autoplay=true&f4=4010000&f5=30000; __Secure-YNID=22.YT=a-c7RsBFLLrE1aj1SmbB-maw8m-zBKhLHcULgGLPxTz9OV7_yx8z7-TwAoOoAvvtiyO4hgJji7t4Xq9MtWmw2CaFFxWYVG0cHdHxyHZ8UIHNYDZ8Xo-GzuOXenzAsjS0TzZs3bsV5TU6AqJXuyhFFYTYM5ZFUNWoIZAH2GQK59mYKpw_4KAhbmBsDELFGFV9SZdYuh-JYVFP8LxMVR3ZzMlxjJqoBfWJDPFb7wYA-LqqUlGFGCdW2hjM8pXDbgTiO7Q_XMtEat8v7J6c3e6L8daRfTGPdxTZVjLzd52ExCLLOhJe6CHLX_BWaSioEIR9Np3rMQ1_JjETFmn-dDA7pg; __Secure-ROLLOUT_TOKEN=CJaQyK2z6s6EChCfyvLdl_-UAxjege_LmI6XAw%3D%3D; __Secure-1PSIDTS=sidts-CjUBkldj_9pjpbfj5OXAHUAEMhAxQqp2taKU08bSxc_tIkQEO5i7QfSzLrt6_9riO2FMzsYO5hAA; __Secure-3PSIDTS=sidts-CjUBkldj_9pjpbfj5OXAHUAEMhAxQqp2taKU08bSxc_tIkQEO5i7QfSzLrt6_9riO2FMzsYO5hAA; SIDCC=AKEyXzVH433777l5Q1UEtixbqhFeanrS5VJ5n71H_3GUcENXq9QPiB3Ys4x8SdL0LaS85wM3vA; __Secure-1PSIDCC=AKEyXzX5eNhB5DN3xuJPsUXiLnd2ZebvNg3E97BlInZjGD1PRxaQZleNDO9zBCHjQ3x4Wp2yjSw; __Secure-3PSIDCC=AKEyXzVTm3D3Ru9jKAid0B7Ok_DdZpx2u3__8BogoyCOvhwyZpFjjDUkVvyPrL32uKUAkRDJpw";

const sapisidMatch = cookie.match(/SAPISID=([^;]+)/);
const sapisid = sapisidMatch ? sapisidMatch[1].trim() : "";

function getDynamicAuth() {
  const origin = "https://studio.youtube.com";
  const now = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash("sha1").update(`${now} ${sapisid} ${origin}`).digest("hex");
  return `SAPISIDHASH ${now}_${hash}_u SAPISID1PHASH ${now}_${hash}_u SAPISID3PHASH ${now}_${hash}_u`;
}

const headers = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9,mr;q=0.8",
  "authorization": getDynamicAuth(),
  "content-type": "application/json",
  "x-goog-authuser": "1",
  "x-origin": "https://studio.youtube.com",
  "x-youtube-client-name": "62",
  "x-youtube-client-version": "1.20260924.00.01",
  "x-youtube-delegation-context": "EhhVQ1VOYm9nbnJYcVVXekpPdHJLOFlQMkEqAggI",
  "cookie": cookie,
  "Referer": "https://studio.youtube.com/channel/UCUNbognrXqUWzJOtrK8YP2A/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=UCUNbognrXqUWzJOtrK8YP2A&time_period=4_weeks&explore_type=SUBSCRIBERS"
};

const payload = {
  nodes: [
    {
      key: "0__CUMULATIVE_SUBSCRIBERS_KEY",
      value: {
        getCards: {
          screenConfig: {
            entity: { channelId: "UCUNbognrXqUWzJOtrK8YP2A" },
            timePeriod: { timePeriodType: "ANALYTICS_TIME_PERIOD_TYPE_FOUR_WEEKS" },
            currency: "USD",
            timeZoneOffsetSecs: 19800
          },
          cardConfigs: [
            {
              autoUpdateInterval: "ANALYTICS_AUTO_UPDATE_INTERVAL_NEVER",
              cumulativeSubscribersCardConfig: {
                returnTableData: true,
                returnLifetimeTotal: true
              }
            }
          ],
          enabledExperiments: [],
          experimentFlags: [],
          fetchingType: "FETCHING_TYPE_FOREGROUND"
        }
      }
    }
  ],
  connectors: [],
  allowFailureResultNodes: true,
  context: {
    client: {
      clientName: 62,
      clientVersion: "1.20260924.00.01",
      hl: "en-IN",
      gl: "IN",
      experimentsToken: "",
      utcOffsetMinutes: 330,
      userInterfaceTheme: "USER_INTERFACE_THEME_LIGHT",
      screenWidthPoints: 1920,
      screenHeightPoints: 518,
      screenPixelDensity: 1,
      screenDensityFloat: 1
    },
    request: {
      returnLogEntry: true,
      internalExperimentFlags: [],
      sessionInfo: {
        token: "AUQqFwlTZxzucyE2PtpZRRfpULWm2GE9-M8oIa1yEz5CgDuGF1E8JDAD9e7oItWN6IZjAimPGV8U78S6LwW25iQQwHS9_YxERMekmtLodkdEndp2jY-xtVNNtC3jx9MzQynC45r_hr2m06_Myp81ISfqZbKdQ-EQlw=="
      },
      consistencyTokenJars: []
    },
    user: {
      delegationContext: {
        externalChannelId: "UCUNbognrXqUWzJOtrK8YP2A",
        roleType: { channelRoleType: "CREATOR_CHANNEL_ROLE_TYPE_OWNER" }
      },
      serializedDelegationContext: "EhhVQ1VOYm9nbnJYcVVXekpPdHJLOFlQMkEqAggI"
    },
    clickTracking: { visualElement: { veType: 38408 } },
    clientScreenNonce: "ne0cNxMyNQc9i0Iw"
  },
  trackingLabel: "web_yta_unbatched"
};

async function main() {
  console.log("Testing dynamic SAPISIDHASH fetch...");
  console.log("Authorization:", headers.authorization);
  const res = await fetch("https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json", {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  console.log("Status:", res.status);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    const total = data.results?.[0]?.value?.getCards?.cards?.[0]?.cumulativeSubscribersCardData?.lifetimeTotal;
    console.log("Lifetime Total:", total);
  } catch (e) {
    console.log("Response text:", text.slice(0, 300));
  }
}

main().catch(console.error);
