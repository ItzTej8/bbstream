const headers = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9,mr;q=0.8",
  "authorization": "SAPISIDHASH 1790509384_5fb2fd9a54e269ae7e8717dd2378e2c67a0108b0_u SAPISID1PHASH 1790509384_5fb2fd9a54e269ae7e8717dd2378e2c67a0108b0_u SAPISID3PHASH 1790509384_5fb2fd9a54e269ae7e8717dd2378e2c67a0108b0_u",
  "content-type": "application/json",
  "priority": "u=1, i",
  "sec-ch-ua": "\"Not=A?Brand\";v=\"99\", \"Google Chrome\";v=\"151\", \"Chromium\";v=\"151\"",
  "sec-ch-ua-arch": "\"x86\"",
  "sec-ch-ua-bitness": "\"64\"",
  "sec-ch-ua-form-factors": "\"Desktop\"",
  "sec-ch-ua-full-version": "\"151.0.7922.175\"",
  "sec-ch-ua-full-version-list": "\"Not=A?Brand\";v=\"99.0.0.0\", \"Google Chrome\";v=\"151.0.7922.175\", \"Chromium\";v=\"151.0.7922.175\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": "\"\"",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-ch-ua-platform-version": "\"19.0.0\"",
  "sec-ch-ua-wow64": "?0",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-browser-channel": "stable",
  "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
  "x-browser-validation": "n3vfL909mLjmn69wqLR0nP++fWE=",
  "x-browser-year": "2026",
  "x-client-data": "CKmdygEIlKHLAQiFoM0BCO3flDAYrN+UMBiz4JQw",
  "x-goog-authuser": "1",
  "x-goog-visitor-id": "CgtEVElHLVo0NmZoSSiTgeTVBjIKCgJJThIEGgAgGmLfAgrcAjIyLllUPWEtYzdSc0JGTExyRTFhajFTbWJCLW1hdzhtLXpCS2hMSGNVTGdHTFB4VHo5T1Y3X3l4OHo3LVR3QW9Pb0F2dnRpeU80aGdKamk3dDRYcTlNdFdtdzJDYUZGeFdZVkcwY0hkSHh5SFo4VUlITllEWjhYby1HenVPWGVuekFzalMwVHpaczNic1Y1VFU2QXFKWHV5aEZGWVRZTTVaRlVOV29JWkFIMkdRSzU5bVlLcHdfNEtBaGJtQnNERUxGR0ZWOVNaZFl1aC1KWVZGUDhMeE1WUjNaek1seGpKcW9CZldKRFBGYjd3WUEtTHFxVWxHRkdDZFcyaGpNOHBYRGJnVGlPN1FfWE10RWF0OHY3SjZjM2U2TDhkYVJmVEdQZHhUWlZqTHpkNTJFeENMTE9oSmU2Q0hMWF9CV2FTaW9FSVI5TnAzck1RMV9KakVURm1uLWREQTdwZw%3D%3D",
  "x-origin": "https://studio.youtube.com",
  "x-youtube-ad-signals": "dt=1790509210703&flash=0&frm&u_tz=330&u_his=26&u_h=1080&u_w=1920&u_ah=1032&u_aw=1920&u_cd=24&bc=31&bih=518&biw=1920&brdim=0%2C0%2C0%2C0%2C1920%2C0%2C1920%2C1032%2C1920%2C518&vis=1&wgl=true&ca_type=image",
  "x-youtube-client-name": "62",
  "x-youtube-client-version": "1.20260924.00.01",
  "x-youtube-delegation-context": "EhhVQ1VOYm9nbnJYcVVXekpPdHJLOFlQMkEqAggI",
  "x-youtube-page-cl": "986666773",
  "x-youtube-page-label": "youtube.studio.web_20260924_00_RC01",
  "x-youtube-time-zone": "Asia/Calcutta",
  "x-youtube-utc-offset": "330",
  "cookie": "VISITOR_INFO1_LIVE=DTIG-Z46fhI; VISITOR_PRIVACY_METADATA=CgJJThIEGgAgGg%3D%3D; _gcl_au=1.1.1572519284.1783620587; YSC=Zwb2wJ3IkJI; LOGIN_INFO=AFmmF2swRQIhAKTu9f7BPmiDj7ii2BPXcTJoHXUJz_1EqlJkXLSwxCScAiABhVSxw_MlNltP6seTb4NSuhoGFiocwJdtJyUPaiLCZg:QUQ3MjNmeE9YbU55aVN4T29LSFlMcUFwaU5sem04U3RoVEY2RDhYVDh1SXV5RS04TVlXdWo1LUZaM2I0MkpPTC1KNmM3bnF0bTFxdDZBTG9kUUI0VWVkWXFRWUpyeWRQRWNVaGIzR2JId29kT2lkR2ljUDRQT19CMGZubW5tNzZFbnBLbThHNlZRSVl5WVNYVUYyOEpFN056bVRtMjgtclZ3; HSID=AtsxZhv4DV6ifjGaS; SSID=AkKPr5OOv9I8k5Nph; APISID=TWI5cGWIoKzg3qGj/ABWzS7tBaFsU80Kao; SAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-1PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; __Secure-3PAPISID=ZCAvfM-PmMN4aOM2/Auinfbqb1pMnOVJ1f; SID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYz58PC5wij0UefSc6Wc5akwACgYKAc4SARUSFQHGX2MiQKThy3VzxcAiwsN40uue5hoVAUF8yKonRJaWNtHG4882SGRMlsMJ0076; __Secure-1PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYnVhQ015ZXmLcXVtfHJIE3gACgYKAdMSARUSFQHGX2MiayHeX2SRtCBbXKT20oAcWxoVAUF8yKp6cSKyLj8ZcIc5azYMcUrc0076; __Secure-3PSID=g.a000DAnngZoU271O8qd6zI37RMiYqtUV27D1U4lPMWpz_WeL33xYvuQ9Qw5Fj9_x31qJvt9ZxgACgYKAXISARUSFQHGX2MiDbupJahxU4INHCBPv6JYSxoVAUF8yKoCrAYpbLs88p_Qx3d-mQKM0076; PREF=tz=Asia.Calcutta&f7=100&repeat=NONE&autoplay=true&f4=4010000&f5=30000; __Secure-YNID=22.YT=a-c7RsBFLLrE1aj1SmbB-maw8m-zBKhLHcULgGLPxTz9OV7_yx8z7-TwAoOoAvvtiyO4hgJji7t4Xq9MtWmw2CaFFxWYVG0cHdHxyHZ8UIHNYDZ8Xo-GzuOXenzAsjS0TzZs3bsV5TU6AqJXuyhFFYTYM5ZFUNWoIZAH2GQK59mYKpw_4KAhbmBsDELFGFV9SZdYuh-JYVFP8LxMVR3ZzMlxjJqoBfWJDPFb7wYA-LqqUlGFGCdW2hjM8pXDbgTiO7Q_XMtEat8v7J6c3e6L8daRfTGPdxTZVjLzd52ExCLLOhJe6CHLX_BWaSioEIR9Np3rMQ1_JjETFmn-dDA7pg; __Secure-ROLLOUT_TOKEN=CJaQyK2z6s6EChCfyvLdl_-UAxjege_LmI6XAw%3D%3D; __Secure-1PSIDTS=sidts-CjUBkldj_9_dDCYZaTrMEcS09QEKZ6Fm0PK0wecyrFp-s3v5_nY7ecfrNSx2b0XUtHzh4yIl6xAA; __Secure-3PSIDTS=sidts-CjUBkldj_9_dDCYZaTrMEcS09QEKZ6Fm0PK0wecyrFp-s3v5_nY7ecfrNSx2b0XUtHzh4yIl6xAA; SIDCC=AKEyXzWaeMabM_odGHB-2O4mpoZBueFjroJ8_pCUzWHo0IceOIMxGdSDkY049YzxQ9t-ErO0Iw; __Secure-1PSIDCC=AKEyXzV5NUgsIne75ZHNaNW1I90odcAGa6MyW-QKUojwM3pkROubtb4SPKfisRFUpCBNSiT3csk; __Secure-3PSIDCC=AKEyXzV8B-j8UpIP_mzdT6eGxX99DKRca_zTPp3UIlZY2IXnU6OARby_z9-_fKxoFGsIbKcOhA",
  "Referer": "https://studio.youtube.com/channel/UCUNbognrXqUWzJOtrK8YP2A/analytics/tab-overview/period-default/explore?entity_type=CHANNEL&entity_id=UCUNbognrXqUWzJOtrK8YP2A&time_period=4_weeks&explore_type=SUBSCRIBERS"
};

const body = JSON.stringify({
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
              cumulativeSubscribersCardConfig: { returnTableData: true, returnLifetimeTotal: true }
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
      eats: "AXoBSW_mhjhbBg7gv8DOlgZKsW1EJ8YXcIUF1lO8GFTjr-aBE-uRnilLXUFS8pzzLBGHFxbb6Ftk-CrfpN03UUAj5dEIoOeudODFMuV_UJzBvsEMlmAfRx1keu-wLg==",
      sessionInfo: {
        token: "AUQqFwnpKXGB1qVzN3Ftvd8mLrQ7a83j1SJqnY4mF4LVu_fQu_an7yUuXCjeK49eHCSFP1areSLCShdhJChcRUSBY8uGirA6owYTNNHv9qzFxa1y-7RRPicIIWcFpBnit2HFy6xUHDfCxpp_xsk0YJP8IGndB1wG6Q=="
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
    clientScreenNonce: "1MnxCtgTMs5Tc-v2"
  },
  trackingLabel: "web_yta_unbatched"
});

async function main() {
  const res = await fetch("https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json", {
    method: "POST",
    headers,
    body
  });
  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Response text:", text.slice(0, 500));
  try {
    const data = JSON.parse(text);
    const lifetimeTotal = data.results?.[0]?.value?.getCards?.cards?.[0]?.cumulativeSubscribersCardData?.lifetimeTotal;
    console.log("Lifetime Total Subscribers:", lifetimeTotal);
  } catch {}
}

main().catch(console.error);
