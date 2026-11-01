module.exports = {
  content: ['./src.html', './export_app.js', './login.html', './admin.html'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Segoe UI"', '"Segoe UI Variable"', 'system-ui', '-apple-system', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'] },
      colors: {
        zuna: {50:'#f4f2fb',100:'#e6e2f6',200:'#cdc5ec',300:'#a99bdc',400:'#7d68c6',500:'#5d5887',600:'#432a93',700:'#2f1878',800:'#200b66',900:'#12005A',950:'#0b003a'},
        mint: {50:'#e6faf3',100:'#c0f2df',200:'#8de7c7',300:'#4fd9aa',400:'#1ecf97',500:'#02C988',600:'#00a874',700:'#00855c',800:'#006a4b',900:'#00573e'}
      },
      minWidth: { 7: '1.75rem' }
    }
  },
  plugins: []
};
