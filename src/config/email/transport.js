import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 1025,
    secure: false, // true for 465, false for other ports
    tls: {
        rejectUnauthorized: false
    }
});

export default transport;