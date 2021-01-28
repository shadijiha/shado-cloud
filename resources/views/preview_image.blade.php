@extends('layouts.index')

@section('scripts')
    <script>
        const file = {!! json_encode($file) !!};
    </script>
@endsection

@section('content')
    <div id="file_preview_dashboard"></div>
    <img src="{{route("get_image", $path)}}" style="width: 70%; margin: auto; text-align: center;">
    <br/>
@endsection
