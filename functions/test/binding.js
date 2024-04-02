/* eslint-disable no-irregular-whitespace */
/* eslint-disable no-tabs */
/* eslint-disable max-len */
const email1 = {
  "SPF": "pass",
  "attachments": "0",
  "charsets": `{"to":"UTF-8","from":"UTF-8","subject":"UTF-8","text":"utf-8","html":"utf-8"}`,
  "dkim": "{@gmail.com : pass}",
  "envelope": `{"to":["calendar@fwd2cal.com"],"from":"jondoe@gmail.com"}`,
  "from": "Jon Doe <jondoe@gmail.com>",
  "headers": `Content-Type: multipart/alternative; boundary="0000000000000f12e420614b61f6a"
    DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;        d=gmail.com; s=20230601; t=1711622313; x=1712227113; darn=fwd2cal.com;        h=to:subject:message-id:date:from:in-reply-to:references:mime-version         :from:to:cc:subject:date:message-id:reply-to;        bh=VcrjtrpPYi9Bt/kfjz9uIRySn0GCXUGae6f3/u6YmhI=;        b=UAjLPWTrzxT/kaJJERTco1Ps5zHK3d3mZX7MOaj7LqdFyjtVFwNOrSGy3e2LE9UvVS         iTESq02/mVB1pTvZqwsaI/K0YSaGjui9619nxi5dwaO/QySHvOSZ3SarmWuTSBs/XVw0         KRuXvEJ5CZ0sQRzfXO9nSVBMvDdobBPybTlgFuKQMHbtLiluAxZCz+wZvyLkMP9NYl8J         YzuaChshk6OHxDAYw2HoW7BdCEVRtqWRPUm1+hCV80lLxnrlWuzjOTgbrqPpiEohabYg         vT5MvWg2zSN4USlQqL80m035Y1Spa8le53KtHHHr/FquQhsp4jlMPUDVZEoovUaPpjWA         TYHA==
    Date: Thu, 28 Mar 2024 10:38:21 +0000
    From: Jon Doe <jondoe@gmail.com>
    In-Reply-To: <0102018e7a6e84ed-c41fff4f-700a-4606-bbcb-c4051ba055cd-000000@eu-west-1.amazonses.com>
    MIME-Version: 1.0
    Message-ID: <CAA4swFcWNQJRndNXq0u3Gcs-0U7kBXmMxNh6gS6qtXk7V4KqXw@mail.gmail.com>
    Received: from mail-pj1-f44.google.com (mxd [209.85.216.44]) by mx.sendgrid.net with ESMTP id dXoUcqmOSqe8hO0WFt6vsQ for <calendar@fwd2cal.com>; Thu, 28 Mar 2024 10:38:33.988 +0000 (UTC)
    Received: by mail-pj1-f44.google.com with SMTP id 98e67ed59e1d1-29dfad24f36so634763a91.0        for <calendar@fwd2cal.com>; Thu, 28 Mar 2024 03:38:33 -0700 (PDT)
    References: <0102018e7a6e84ed-c41fff4f-700a-4606-bbcb-c4051ba055cd-000000@eu-west-1.amazonses.com>
    Subject: Fwd: Finess Clinic Appointment Confirmation
    To: calendar@fwd2cal.com
    X-Gm-Message-State: AOJu0Yx7KViB979IYYeK6S1QzIqMpgqyMQFTmhFh89Jg3XX2iXvPfY/5	RnWgjTG8A2xecs85V/6ty7ISvvVLOrz8fMAQqdZE17/m3rr0Dqk73v9RbX5dRte4jF6X1RRoh9G	8xCNTy3c+uBs6oTF2QQdJHaZrTAJatc3tQkI=
    X-Google-DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;        d=1e100.net; s=20230601; t=1711622313; x=1712227113;        h=to:subject:message-id:date:from:in-reply-to:references:mime-version         :x-gm-message-state:from:to:cc:subject:date:message-id:reply-to;        bh=VcrjtrpPYi9Bt/kfjz9uIRySn0GCXUGae6f3/u6YmhI=;        b=YoacecYc7qtyCtYDV6Rf9d+6xvgsq2C8JHLhbweKI6/DFu1Aqplgp2vmuyNxuZM3hR         IIe0p+J3kUmAnIRG6N+XFvU7j0XwrKtZt2EY1SG5wUiahi5q+SKCbYa6/6diT8RDklNx         5Ut6nRP9sF+EZxHnZwq4JM9vGPPIpB0XziUK6Nra7PFnhWOpDYgVKkG6/qvaRD84LRHh         yN6E7ENIvaOYdHIy8HGJy4zlkOKt264LgXh0Qh02reGfDr2Ng8hv3e1A64jtS93ne8yx         XfPJxX4iPWbBGTIncCuinZFf0+Yn5o3TYH5JFf7cmbSOMEMvBavIq2af0q8HqbhRBiuV         sW2A==
    X-Google-Smtp-Source: AGHT+IEc9vMa5b3wFzeMcFWyXKWFNGIXAsPg7hA/o63o4JEOr4urEW2JNXs9XJ9FH8ZoYR4+zz7SP2VOlotrtd0PZYQ=
    X-Received: by 2002:a17:90a:2f05:b0:29b:2268:3349 with SMTP id s5-20020a17090a2f0500b0029b22683349mr2184697pjd.18.1711622312765; Thu, 28 Mar 2024 03:38:32 -0700 (PDT)
    `,
  "html": `<div dir="ltr"><br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Finess Clinic</strong> <span dir="auto">&lt;<a href="mailto:noreply@treatwell.co.uk">noreply@treatwell.co.uk</a>&gt;</span><br>Date: Tue, Mar 26, 2024 at 11:04 AM<br>Subject: Finess Clinic Appointment Confirmation<br>To:  &lt;<a href="mailto:jondoe@gmail.com">jondoe@gmail.com</a>&gt;<br></div><br><br><div class="msg-8594583518145648811"><table id="m_-8594583518145648811view-email-on-site" cellpadding="4" width="100%" border="0" color="#888888"><tbody><tr><td color="#000000" style="color:#646464;font-family:Arial,Helvetica,sans-serif;font-size:16px;text-align:center">Email having a bad hair day? <a href="https://www.treatwell.co.uk/email/r35abc3c0-d978-497d-9bce-197baa779003.x607CA89B/" style="color:#5a6a9d" target="_blank">Click here to view it in your browser</a></td></tr></tbody></table><u></u>
    
      
        
        
        
      
      <div style="margin:0;padding:0"><img src="https://www.treatwell.co.uk/t/o/r35abc3c0-d978-497d-9bce-197baa779003.x607CA89B" style="display:none" width="1" height="1">
        <table border="0" width="100%" style="border-collapse:collapse;background-color:#f2f2f2">
          <tbody><tr>
            <td height="16"></td>
          </tr>
          <tr>
            
            <td align="center" width="600">
              
              
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff">
        <tbody><tr>
            <td colspan="3" height="16"></td>
        </tr>
        <tr>
            <td width="30"></td>
            <td colspan="2" width="570">
                <table style="width:100%">
                    <tbody>
                        <tr>
                            <td>
                                                                <span style="font-size:24px;color:#222222;font-weight:bold;line-height:normal">Finess Clinic</span>
                                                        </td>
                            <td style="vertical-align:top">
                                                                <img src="https://cdn1.treatwell.net/images/view/v2.i226318.w152.h29.x0AB36038.png" alt="" width="152" height="29" border="0" style="display:block;float:right" hspace="0" vspace="0">
                                                        </td>
                        </tr>
                    </tbody>
                </table>
    
            </td>
        </tr>
        <tr>
            <td colspan="3" height="12"></td>
        </tr>
    </tbody></table>
    
    
    
    
    
      <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff">
        <tbody><tr>
          <td width="30"></td>
          <td>
                    <img src="https://cdn1.treatwell.net/images/view/v2.i3281461.w1080.h312.xF8165A21.jpg" alt="Your booking is confirmed" width="540" border="0" style="display:block" hspace="0" vspace="0">
                  </td>
          <td width="30"></td>
        </tr>
      </tbody></table>
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;text-align:center;letter-spacing:-0.5px">
      <tbody><tr>
        <td width="30"></td>
        <td width="540">
                  <p style="text-align:center;margin-bottom:16px">Everything you need to know about your upcoming appointment is here.<br></p>
            <a href="https://treatwell.onelink.me/32083905?pid=wahanda-email&amp;c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&amp;content=Banner&amp;is_retargeting=true&amp;af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&amp;af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk" target="_blank"><img style="margin-right:12px" src="https://cdn1.treatwell.net/images/view/v2.i1888408.w957.h287.x54543158.png" height="39px"></a>
            <a href="https://treatwell.onelink.me/32083905?pid=wahanda-email&amp;c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&amp;content=Banner&amp;is_retargeting=true&amp;af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&amp;af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk" target="_blank"><img src="https://cdn1.treatwell.net/images/view/v2.i1888409.w980.h287.x6510A115.png" height="39px"></a>
    
              </td>
        <td width="30"></td>
      </tr>
      <tr>
        <td height="30" colspan="3"></td>
      </tr>
    </tbody></table>
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff">
      <tbody><tr>
        <td width="30" height="10"></td>
        <td width="526" style="padding:5px;border:2px solid #f2f2f2;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px">
    
    
    
    
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
      
      <tbody><tr>
        <td width="526">
                  <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Your booking information</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
        </td>
      </tr>
    
      <tr>
        <td width="526">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
            <tbody><tr>
              <td width="129" style="padding-left:21px">Order reference:</td>
              <td width="376">W1503268392</td>
            </tr>
            <tr>
              <td width="129" style="padding-left:21px">Date order placed:</td>
              <td width="376">26 March 2024</td>
            </tr>
    
                      
              <tr>
                <td colspan="2" height="10"></td>
              </tr>
              <tr>
                <td width="129" style="padding-left:21px">When:</td>
                <td width="376">11:15, 26 March 2024</td>
              </tr>
    
                                    <tr>
                  <td width="129" style="padding-left:21px">Booked for:</td>
                  <td width="376">Jon Doe</td>
                </tr>
                                        <tr>
              <td height="18" colspan="2"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
    </tbody></table>
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
            <tbody><tr>
                <td width="526">
                    
                      <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Change your booking?</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
                </td>
            </tr>
            <tr>
                <td>
                    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;display:inline-block;width:115px">
                        <tbody><tr>
                            <td width="30"></td>
                            <td width="115">
                                <img src="https://cdn1.treatwell.net/images/view/v2.i1747073.w444.h444.x965CAE78.png" width="115" height="115" border="0" style="display:block" hspace="0" vspace="0">
                            </td>
                            <td width="30"></td>
                        </tr>
                    </tbody></table>
                    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;display:inline-block;width:375px">
                        <tbody><tr>
                            <td width="484" style="padding:0 21px">
    
                                                                                        
                                If you can no longer make it to your appointment, please reschedule. That way, the salon can try to refill your slot with a new client and you still get the treatment you wanted, just at a different time. If you need to cancel, read our cancellation policy for more details.                            
                            </td>
                        </tr>
                        <tr>
                            <td height="12"></td>
                        </tr>
                        <tr>
                            <td style="padding-left:21px">
                                <table>
                                    <tbody>
                                        <tr height="40">
                                            <td width="180">
                                                <a href="https://widget.treatwell.co.uk/reschedule-bookings?token=oW1503268392.aVRC.x1FD8417D&amp;venueId=421878" style="padding:12px;border-radius:4px;background-color:#ff5c39;color:#ffffff;text-align:center;text-decoration:none;display:inline-block;width:100%;letter-spacing:0.2px" target="_blank">
                                                  Reschedule
                                                </a>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                    </tbody></table>
                </td>
            </tr>
        <tr>
            <td height="21"></td>
        </tr>
        <tr>
            <td style="border:1px solid #f2f2f2"></td>
        </tr>
    </tbody></table>
    
    
    
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
      <tbody><tr>
        <td width="526">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
            <tbody><tr height="30" style="background-color:#f2f2f2;vertical-align:middle;font-size:14px;text-align:center">
              <td width="319" style="padding-left:21px;text-align:left">What</td>
              <td width="55">Quantity</td>
              <td width="55">Price</td>
              <td width="55" style="padding-right:21px">Subtotal</td>
            </tr>
          </tbody></table>
        </td>
      </tr>
    
        
      <tr>
        <td height="12"></td>
      </tr>
      <tr>
        <td width="526">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;text-align:center">
                      <tbody><tr>
                <td width="319" style="font-weight:bold;padding-left:21px;text-align:left">
                 Acupuncture
    
                                  <span style="font-weight:normal;display:inline-block">30 minutes</span>
                              </td>
                <td width="55" style="font-size:12px;line-height:16px"></td>
                <td width="55" style="font-size:12px;line-height:16px"></td>
                <td width="55" style="font-size:12px;line-height:16px;padding-right:21px"></td>
              </tr>
              <tr>
                <td height="6" colspan="4" style="background-color:#ffffff"></td>
              </tr>
    
              <tr>
                <td width="319" style="padding-left:21px;text-align:left">30 Minutes</td>
                <td width="55" style="font-size:12px;line-height:16px">1</td>
                <td width="55" style="font-size:12px;line-height:16px"> £45.00</td>
                <td width="55" style="font-size:12px;line-height:16px;padding-right:21px">  £45.00</td>
              </tr>
              <tr>
                <td height="12" colspan="4"></td>
              </tr>
            
            <tr>
              <td height="12" colspan="4"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
    
        
        
      <tr>
        <td width="526">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
            <tbody><tr>
              <td height="2" colspan="2" style="background-color:#f2f2f2"></td>
            </tr>
            <tr>
              <td height="10" colspan="2"></td>
            </tr>
    
                                      
                    
                      
            <tr>
              <td width="414" style="font-weight:bold;text-align:right">Amount to pay at the salon </td>
              <td width="55" style="font-weight:bold;text-align:right;padding-left:15px;padding-right:21px"> £45.00 </td>
            </tr>
    
                      <tr>
                <td height="14" colspan="2"></td>
              </tr>
              <tr>
                <td colspan="2" style="padding:0 20px;line-height:20px;letter-spacing:-0.5px"><p>This appointment has not been paid for. Please note that you will have to pay at the salon after receiving your treatment. If you secured your appointment with your card details, you may risk being charged up to the full cost of your booking if you:</p>
    
    <ul>
            <li>Cancel outside of the cancellation period</li>
            <li>Fail to show up for your appointment</li>
    </ul>
    </td>
              </tr>
              <tr>
                <td height="14" colspan="2"></td>
              </tr>
            
                      
            <tr>
              <td colspan="2" style="border:1px solid #f2f2f2;width:540px"></td>
            </tr>
            <tr>
              <td height="6" colspan="2"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
            
    </tbody></table>
    
    
    
    
      
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
      <tbody><tr>
        <td width="526">
                  <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Your destination</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
        </td>
      </tr>
      <tr>
        <td width="540">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
            <tbody><tr>
              <td width="307" style="padding-left:21px">
                <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
                  <tbody><tr>
                    <td>
                      <a href="https://www.treatwell.co.uk/place/finess-clinic/?utm_source=wahanda-email&amp;utm_medium=email&amp;utm_campaign=wahanda-customer-order-confirmation&amp;utm_term=35abc3c0-d978-497d-9bce-197baa779003" style="text-decoration:none" target="_blank">
                        <span style="color:#ff5c39">Finess Clinic</span>
                      </a>
                    </td>
                  </tr>
    
                                  <tr>
                      <td>Suite 1, Beatty House</td>
                    </tr>
                                  <tr>
                      <td>Admirals Way</td>
                    </tr>
                                  <tr>
                      <td>Canary Wharf</td>
                    </tr>
                                  <tr>
                      <td>London</td>
                    </tr>
                  
                                  <tr>
                      <td>UK</td>
                    </tr>
                  
                                  <tr>
                      <td>E14 9UF</td>
                    </tr>
                  
                                  <tr>
                      <td>
                        <a href="https://www.google.com/maps/place/51.5016851,-0.0209547" style="text-decoration:none" target="_blank">
                          <span style="color:#ff5c39">Get directions</span>
                        </a>
                      </td>
                    </tr>
                  
                  <tr>
                    <td height="15"></td>
                  </tr>
                </tbody></table>
              </td>
              <td width="213" style="padding-right:21px">
              </td>
            </tr>
            <tr>
              <td height="16" colspan="2"></td>
            </tr>
            <tr>
              <td colspan="2" style="border:1px solid #f2f2f2"></td>
            </tr>
            <tr>
              <td height="6" colspan="4"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
    </tbody></table>
    
    
    
      <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Venue contact details</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
    
    
    <table cellspacing="0" cellpadding="0" style="width:100%">
      <tbody><tr height="23">
        
                  <td width="10%" style="padding-left:16px;vertical-align:top">
              Email:
            </td>
            <td width="50%" style="padding-left:16px;vertical-align:top">
              <a href="mailto:finessclinic@hotmail.com" target="_blank">finessclinic@hotmail.com</a>
            </td>
            </tr>
      <tr height="23">
                  <td width="10%" style="padding-left:16px;vertical-align:top">
              Telephone:
            </td>
            <td width="50%" style="padding-left:16px;vertical-align:top">
              <a href="tel:+442033029710" target="_blank">+442033029710</a>
            </td>
            </tr>
    </tbody></table>
    
    
    <table border="0" width="100%" cellpadding="0" cellspacing="0">
      <tbody><tr>
        <td height="14"></td>
      </tr>
      <tr>
         <td height="7"></td>
      </tr>
    </tbody></table>
    
    
    
    
    
    
    
    
    
    
    
    
      <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Important details</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
      <tbody><tr>
        <td width="517" style="background-color:#ffffff">
          <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
            
                                                          
                      
                    
                      <tbody><tr>
                <td width="21"></td>
                <td valign="top" width="200" style="line-height:18px;text-align:left;letter-spacing:-0.25px;font-weight:bold">Venue policies</td>
                <td width="275" style="line-height:18px;text-align:left;letter-spacing:-0.25px">
                  
      
      
      
      
      
        
      
      
      <p style="font-weight:bold;line-height:20px;margin-bottom:8px;margin-top:0">Reschedule policy</p>
      <p style="line-height:20px;margin-bottom:24px">If your plans change, you can reschedule your booking up to 1 hour before your appointment.</p>
    
      <p style="font-weight:bold;line-height:20px;margin-bottom:8px">Cancellation policy</p>
    
            <p style="line-height:20px;margin-bottom:24px">To protect the venue, if you need to cancel, it’s important to let them know as soon as possible, so they have a chance to refill your slot.</p>
      
    
    
                                <p>
                    <a href="https://widget.treatwell.co.uk/account/cancel?token=oW1503268392.aVRC.x1FD8417D" style="color:#ff5c39;text-decoration:none;letter-spacing:0.2px" target="_blank">
                        Cancel booking
                    </a>
                  </p>
                              </td>
                <td width="21"></td>
              </tr>
            
            <tr>
              <td height="12" colspan="4"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
    </tbody></table>
    
    
    
    
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;letter-spacing:-0.25px">
        <tbody><tr>
            <td width="526">
                
                  <table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse">
        <tbody><tr>
          <td style="background-color:#f2f2f2;vertical-align:middle;color:#4d4d4d;font-family:Arial;font-size:16px;padding-left:16px" height="30">Download the app - it&#39;s easier</td>
        </tr>
        <tr>
          <td height="16"></td>
        </tr>
      </tbody></table>
    
            </td>
        </tr>
        <tr>
            <td width="526">
                <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
                    <tbody><tr>
                        <td width="484" style="padding:0 21px">Manage this appointment on the Treatwell app. So, if you need to make a last-minute change,
                            check the venue location, or book another visit, you can. 24/7.
                        </td>
                    </tr>
                    <tr>
                        <td height="12"></td>
                    </tr>
                </tbody></table>
                <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff">
                    <tbody><tr>
                        <td width="30"></td>
                        <td>
                            <a href="https://treatwell.onelink.me/32083905?pid=wahanda-email&amp;c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&amp;content=Banner&amp;is_retargeting=true&amp;af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&amp;af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk" target="_blank">
                                <img src="https://cdn1.treatwell.net/images/view/v2.i1739802.w1449.h723.xA0F55618.png" alt="Your booking is confirmed" width="526" border="0" style="display:block" hspace="0" vspace="0">
                            </a>
                        </td>
                        <td width="30"></td>
                    </tr>
                </tbody></table>
            </td>
        </tr>
        <tr>
            <td height="21"></td>
        </tr>
    </tbody></table>
    
    
    
    
        </td>
        <td width="30" height="10"></td>
      </tr>
      <tr>
        <td colspan="3" height="30"></td> 
      </tr>
    </tbody></table>
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff">
      <tbody><tr>
        <td width="30"></td>
        <td width="540" style="color:#4d4d4d;font-family:Arial,Helvetica,sans-serif;font-size:14px">
    
    
    
        </td>
        <td width="30"></td>
      </tr>
      <tr>
        <td height="10"></td>
      </tr>
    </tbody></table>
    
    
    
    
    
    
    
    
    <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:#4d4d4d;font-weight:normal;text-align:center;background-color:#ffffff">
        </table>
    
    
    
    
    <table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:14px;color:#4d4d4d;font-weight:normal">
      <tbody><tr>
        <td height="33" width="600"></td>
      </tr>
      <tr>
        <td width="600" style="font-family:Arial,Helvetica,sans-serif;padding-bottom:15px">
          <table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse">
            <tbody><tr>
              <td width="30" height="10"></td>
                          <td style="padding-top:5px;padding-right:40px;width:354px;vertical-align:top">You&#39;re receiving this email because you recently made a booking with Finess Clinic.</td>
                <td>
                  <a style="text-decoration:none;display:inline-block;line-height:0px;padding:16px;background-color:#f2f2f2">
                    <img width="114" height="25" src="https://cdn1.treatwell.net/images/view/v2.i1599941.w654.h143.xAB64D8A4.png" alt="" border="0" hspace="0" vspace="0">
                  </a>
                </td>
                        <td width="30" height="10"></td>
            </tr>
          </tbody></table>
        </td>
      </tr>
      <tr>
        <td height="10" width="600"></td>
      </tr>
    </tbody></table>
    
    
    
    
              
            </td>
          </tr>
          <tr>
            <td height="16"></td>
          </tr>
        </tbody></table>
      </div>
    </div></div></div>
    `,
  "message": "sendgridCallback",
  "sender_ip": "209.85.216.44",
  "spam_report": `Spam detection software, running on the system "parsley-p1las1-spamassassin-864946f5dc-2dv42",
    has NOT identified this incoming email as spam.  The original
    message has been attached to this so you can view it or label
    similar future email.  If you have any questions, see
    the administrator of that system for details.
    
    Content preview:  Forwarded message --------- From: Finess Clinic Date: Tue,
       Mar 26, 2024 at 11:04 AM Subject: Finess Clinic Appointment Confirmation
       To: Email having a bad hair day? Click here to view it in your browser <https://www.treatwell.co.uk/email/r35abc3c0-d978-497d-9bce-197baa779003.x607CA89B/>
       Finess Clinic [image: Your booking is confirmed] 
    
    Content analysis details:   (-0.1 points, 5.0 required)
    
     pts rule name              description
    ---- ---------------------- --------------------------------------------------
     0.0 URIBL_BLOCKED          ADMINISTRATOR NOTICE: The query to URIBL was
     0.0 RCVD_IN_ZEN_BLOCKED    RBL: ADMINISTRATOR NOTICE: The query to
    -0.0 RCVD_IN_DNSWL_NONE     RBL: Sender listed at https://www.dnswl.org/,
     0.0 URIBL_ZEN_BLOCKED      ADMINISTRATOR NOTICE: The query to
     0.0 FREEMAIL_FROM          Sender email is commonly abused enduser mail
     0.0 RCVD_IN_MSPIKE_H3      RBL: Good reputation (+3)
     0.0 HTML_MESSAGE           BODY: HTML included in message
    -0.1 DKIM_VALID_AU          Message has a valid DKIM or DK signature from
    -0.1 DKIM_VALID             Message has at least one valid DKIM or DK signature
     0.1 DKIM_SIGNED            Message has a DKIM or DK signature, not necessarily
     0.0 RCVD_IN_MSPIKE_WL      Mailspike good senders
    -0.0 T_SCC_BODY_TEXT_LINE   No description available.
     0.0 T_REMOTE_IMAGE         Message contains an external image
    `,
  "spam_score": "-0.1",
  "subject": "Fwd: Finess Clinic Appointment Confirmation",
  "text": `---------- Forwarded message ---------
    From: Finess Clinic <noreply@treatwell.co.uk>
    Date: Tue, Mar 26, 2024 at 11:04 AM
    Subject: Finess Clinic Appointment Confirmation
    To: <jondoe@gmail.com>
    
    
    Email having a bad hair day? Click here to view it in your browser
    <https://www.treatwell.co.uk/email/r35abc3c0-d978-497d-9bce-197baa779003.x607CA89B/>
    Finess Clinic
    [image: Your booking is confirmed]
    
    Everything you need to know about your upcoming appointment is here.
    <https://treatwell.onelink.me/32083905?pid=wahanda-email&c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&content=Banner&is_retargeting=true&af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk>
    <https://treatwell.onelink.me/32083905?pid=wahanda-email&c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&content=Banner&is_retargeting=true&af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk>
    Your booking information
    Order reference: W1503268392
    Date order placed: 26 March 2024
    When: 11:15, 26 March 2024
    Booked for: Jon Doe
    Change your booking?
    If you can no longer make it to your appointment, please reschedule. That
    way, the salon can try to refill your slot with a new client and you still
    get the treatment you wanted, just at a different time. If you need to
    cancel, read our cancellation policy for more details.
    Reschedule
    <https://widget.treatwell.co.uk/reschedule-bookings?token=oW1503268392.aVRC.x1FD8417D&venueId=421878>
    What Quantity Price Subtotal
    Acupuncture 30 minutes
    30 Minutes 1 £45.00 £45.00
    Amount to pay at the salon £45.00
    
    This appointment has not been paid for. Please note that you will have to
    pay at the salon after receiving your treatment. If you secured your
    appointment with your card details, you may risk being charged up to the
    full cost of your booking if you:
    
       - Cancel outside of the cancellation period
       - Fail to show up for your appointment
    
    Your destination
    Finess Clinic
    <https://www.treatwell.co.uk/place/finess-clinic/?utm_source=wahanda-email&utm_medium=email&utm_campaign=wahanda-customer-order-confirmation&utm_term=35abc3c0-d978-497d-9bce-197baa779003>
    Suite 1, Beatty House
    Admirals Way
    Canary Wharf
    London
    UK
    E14 9UF
    Get directions <https://www.google.com/maps/place/51.5016851,-0.0209547>
    Venue contact details
    Email: finessclinic@hotmail.com
    Telephone: +442033029710
    Important details
    Venue policies
    
    Reschedule policy
    
    If your plans change, you can reschedule your booking up to 1 hour before
    your appointment.
    
    Cancellation policy
    
    To protect the venue, if you need to cancel, it’s important to let them
    know as soon as possible, so they have a chance to refill your slot.
    
    Cancel booking
    <https://widget.treatwell.co.uk/account/cancel?token=oW1503268392.aVRC.x1FD8417D>
    Download the app - it's easier
    Manage this appointment on the Treatwell app. So, if you need to make a
    last-minute change, check the venue location, or book another visit, you
    can. 24/7.
    [image: Your booking is confirmed]
    <https://treatwell.onelink.me/32083905?pid=wahanda-email&c=Supplier%20Customer%20Appointment%20Confirmation%20Widget&content=Banner&is_retargeting=true&af_dp=treatwell%3A%2F%2Fwww.treatwell.co.uk%2Fmy-bookings&af_web_dp=https%3A%2F%2Fwww.treatwell.co.uk>
    You're receiving this email because you recently made a booking with Finess
    Clinic.
    `,
  "to": "calendar@fwd2cal.com",
};

module.exports = {email1};
