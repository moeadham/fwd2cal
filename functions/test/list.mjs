import {Resend} from "resend";

const resend = new Resend("xx");

let {data, error} = await resend.emails.receiving.attachments.list({
  emailId: "a20580a9-02c5-4df4-9bb0-1dd04b50e3b5",
});

console.log(data);
console.log(error);

let {data: data2, error: error2} = await resend.emails.receiving.attachments.get({
  id: data.data[0].id,
  emailId: "a20580a9-02c5-4df4-9bb0-1dd04b50e3b5",
});

console.log(data2);
console.log(error2);